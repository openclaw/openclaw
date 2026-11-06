// Copyright (c) 2016-2017 Károly Lőrentey
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
// of the Software, and to permit persons to whom the Software is furnished to do
// so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
//  BigUInt.swift
//

/// An arbitary precision unsigned integer type, also known as a "big integer".
///
/// Operations on big integers never overflow, but they may take a long time to execute.
/// The amount of memory (and address space) available is the only constraint to the magnitude of these numbers.
///
/// This particular big integer type uses base-2^64 digits to represent integers; you can think of it as a wrapper
/// around `Array<UInt64>`. (In fact, `BigUInt` only uses an array if there are more than two digits.)
public struct BigUInt: UnsignedInteger {
    /// The type representing a digit in `BigUInt`'s underlying number system.
    public typealias Word = UInt

    /// The storage variants of a `BigUInt`.
    enum Kind {
        /// Value consists of the two specified words (low and high). Either or both words may be zero.
        case inline(Word, Word)
        /// Words are stored in a slice of the storage array.
        case slice(from: Int, to: Int)
        /// Words are stored in the storage array.
        case array
    }

    internal fileprivate (set) var kind: Kind // Internal for testing only
    internal fileprivate (set) var storage: [Word] // Internal for testing only; stored separately to prevent COW copies

    /// Initializes a new BigUInt with value 0.
    public init() {
        self.kind = .inline(0, 0)
        self.storage = []
    }

    internal init(word: Word) {
        self.kind = .inline(word, 0)
        self.storage = []
    }

    internal init(low: Word, high: Word) {
        self.kind = .inline(low, high)
        self.storage = []
    }

    /// Initializes a new BigUInt with the specified digits. The digits are ordered from least to most significant.
    public init(words: [Word]) {
        self.kind = .array
        self.storage = words
        normalize()
    }

    internal init(words: [Word], from startIndex: Int, to endIndex: Int) {
        self.kind = .slice(from: startIndex, to: endIndex)
        self.storage = words
        normalize()
    }
}

extension BigUInt {
    public static var isSigned: Bool {
        return false
    }

    /// Return true iff this integer is zero.
    ///
    /// - Complexity: O(1)
    public var isZero: Bool {
        switch kind {
        case .inline(0, 0): return true
        case .array: return storage.isEmpty
        default:
            return false
        }
    }

    /// Returns `1` if this value is, positive; otherwise, `0`.
    ///
    /// - Returns: The sign of this number, expressed as an integer of the same type.
    public func signum() -> BigUInt {
        return isZero ? 0 : 1
    }
}

extension BigUInt {
    mutating func ensureArray() {
        switch kind {
        case let .inline(w0, w1):
            kind = .array
            storage = w1 != 0 ? [w0, w1]
                : w0 != 0 ? [w0]
                : []
        case let .slice(from: start, to: end):
            kind = .array
            storage = Array(storage[start ..< end])
        case .array:
            break
        }
    }

    var capacity: Int {
        guard case .array = kind else { return 0 }
        return storage.capacity
    }

    mutating func reserveCapacity(_ minimumCapacity: Int) {
        switch kind {
        case let .inline(w0, w1):
            kind = .array
            storage.reserveCapacity(minimumCapacity)
            if w1 != 0 {
                storage.append(w0)
                storage.append(w1)
            }
            else if w0 != 0 {
                storage.append(w0)
            }
        case let .slice(from: start, to: end):
            kind = .array
            var words: [Word] = []
            words.reserveCapacity(Swift.max(end - start, minimumCapacity))
            words.append(contentsOf: storage[start ..< end])
            storage = words
        case .array:
            storage.reserveCapacity(minimumCapacity)
        }
    }

    /// Gets rid of leading zero digits in the digit array and converts slices into inline digits when possible.
    internal mutating func normalize() {
        switch kind {
        case .slice(from: let start, to: var end):
            assert(start >= 0 && end <= storage.count && start <= end)
            while start < end, storage[end - 1] == 0 {
                end -= 1
            }
            switch end - start {
            case 0:
                kind = .inline(0, 0)
                storage = []
            case 1:
                kind = .inline(storage[start], 0)
                storage = []
            case 2:
                kind = .inline(storage[start], storage[start + 1])
                storage = []
            case storage.count:
                assert(start == 0)
                kind = .array
            default:
                kind = .slice(from: start, to: end)
            }
        case .array where storage.last == 0:
            while storage.last == 0 {
                storage.removeLast()
            }
        default:
            break
        }
    }

    /// Set this integer to 0 without releasing allocated storage capacity (if any).
    mutating func clear() {
        self.load(0)
    }

    /// Set this integer to `value` by copying its digits without releasing allocated storage capacity (if any).
    mutating func load(_ value: BigUInt) {
        switch kind {
        case .inline, .slice:
            self = value
        case .array:
            self.storage.removeAll(keepingCapacity: true)
            self.storage.append(contentsOf: value.words)
        }
    }
}

extension BigUInt {
    //MARK: Collection-like members

    /// The number of digits in this integer, excluding leading zero digits.
    var count: Int {
        switch kind {
        case let .inline(w0, w1):
            return w1 != 0 ? 2
                : w0 != 0 ? 1
                : 0
        case let .slice(from: start, to: end):
            return end - start
        case .array:
            return storage.count
        }
    }

    /// Get or set a digit at a given index.
    ///
    /// - Note: Unlike a normal collection, it is OK for the index to be greater than or equal to `endIndex`.
    ///   The subscripting getter returns zero for indexes beyond the most significant digit.
    ///   Setting these extended digits automatically appends new elements to the underlying digit array.
    /// - Requires: index >= 0
    /// - Complexity: The getter is O(1). The setter is O(1) if the conditions below are true; otherwise it's O(count).
    ///    - The integer's storage is not shared with another integer
    ///    - The integer wasn't created as a slice of another integer
    ///    - `index < count`
    subscript(_ index: Int) -> Word {
        get {
            precondition(index >= 0)
            switch (kind, index) {
            case (.inline(let w0, _), 0): return w0
            case (.inline(_, let w1), 1): return w1
            case (.slice(from: let start, to: let end), _) where index < end - start:
                return storage[start + index]
            case (.array, _) where index < storage.count:
                return storage[index]
            default:
                return 0
            }
        }
        set(word) {
            precondition(index >= 0)
            switch (kind, index) {
            case let (.inline(_, w1), 0):
                kind = .inline(word, w1)
            case let (.inline(w0, _), 1):
                kind = .inline(w0, word)
            case let (.slice(from: start, to: end), _) where index < end - start:
                replace(at: index, with: word)
            case (.array, _) where index < storage.count:
                replace(at: index, with: word)
            default:
                extend(at: index, with: word)
            }
        }
    }

    private mutating func replace(at index: Int, with word: Word) {
        ensureArray()
        precondition(index < storage.count)
        storage[index] = word
        if word == 0, index == storage.count - 1 {
            normalize()
        }
    }

    private mutating func extend(at index: Int, with word: Word) {
        guard word != 0 else { return }
        reserveCapacity(index + 1)
        precondition(index >= storage.count)
        storage.append(contentsOf: repeatElement(0, count: index - storage.count))
        storage.append(word)
    }

    /// Returns an integer built from the digits of this integer in the given range.
    internal func extract(_ bounds: Range<Int>) -> BigUInt {
        switch kind {
        case let .inline(w0, w1):
            let bounds = bounds.clamped(to: 0 ..< 2)
            if bounds == 0 ..< 2 {
                return BigUInt(low: w0, high: w1)
            }
            else if bounds == 0 ..< 1 {
                return BigUInt(word: w0)
            }
            else if bounds == 1 ..< 2 {
                return BigUInt(word: w1)
            }
            else {
                return BigUInt()
            }
        case let .slice(from: start, to: end):
            let s = Swift.min(end, start + Swift.max(bounds.lowerBound, 0))
            let e = Swift.max(s, (bounds.upperBound > end - start ? end : start + bounds.upperBound))
            return BigUInt(words: storage, from: s, to: e)
        case .array:
            let b = bounds.clamped(to: storage.startIndex ..< storage.endIndex)
            return BigUInt(words: storage, from: b.lowerBound, to: b.upperBound)
        }
    }

    internal func extract<Bounds: RangeExpression>(_ bounds: Bounds) -> BigUInt where Bounds.Bound == Int {
        return self.extract(bounds.relative(to: 0 ..< Int.max))
    }
}

extension BigUInt {
    internal mutating func shiftRight(byWords amount: Int) {
        assert(amount >= 0)
        guard amount > 0 else { return }
        switch kind {
        case let .inline(_, w1) where amount == 1:
            kind = .inline(w1, 0)
        case .inline(_, _):
            kind = .inline(0, 0)
        case let .slice(from: start, to: end):
            let s = start + amount
            if s >= end {
                kind = .inline(0, 0)
            }
            else {
                kind = .slice(from: s, to: end)
                normalize()
            }
        case .array:
            if amount >= storage.count {
                storage.removeAll(keepingCapacity: true)
            }
            else {
                storage.removeFirst(amount)
            }
        }
    }

    internal mutating func shiftLeft(byWords amount: Int) {
        assert(amount >= 0)
        guard amount > 0 else { return }
        guard !isZero else { return }
        switch kind {
        case let .inline(w0, 0) where amount == 1:
            kind = .inline(0, w0)
        case let .inline(w0, w1):
            let c = (w1 == 0 ? 1 : 2)
            storage.reserveCapacity(amount + c)
            storage.append(contentsOf: repeatElement(0, count: amount))
            storage.append(w0)
            if w1 != 0 {
                storage.append(w1)
            }
            kind = .array
        case let .slice(from: start, to: end):
            var words: [Word] = []
            words.reserveCapacity(amount + count)
            words.append(contentsOf: repeatElement(0, count: amount))
            words.append(contentsOf: storage[start ..< end])
            storage = words
            kind = .array
        case .array:
            storage.insert(contentsOf: repeatElement(0, count: amount), at: 0)
        }
    }
}

extension BigUInt {
    //MARK: Low and High
    
    /// Split this integer into a high-order and a low-order part.
    ///
    /// - Requires: count > 1
    /// - Returns: `(low, high)` such that 
    ///   - `self == low.add(high, shiftedBy: middleIndex)`
    ///   - `high.width <= floor(width / 2)`
    ///   - `low.width <= ceil(width / 2)`
    /// - Complexity: Typically O(1), but O(count) in the worst case, because high-order zero digits need to be removed after the split.
    internal var split: (high: BigUInt, low: BigUInt) {
        precondition(count > 1)
        let mid = middleIndex
        return (self.extract(mid...), self.extract(..<mid))
    }

    /// Index of the digit at the middle of this integer.
    ///
    /// - Returns: The index of the digit that is least significant in `self.high`.
    internal var middleIndex: Int {
        return (count + 1) / 2
    }

    /// The low-order half of this BigUInt.
    ///
    /// - Returns: `self[0 ..< middleIndex]`
    /// - Requires: count > 1
    internal var low: BigUInt {
        return self.extract(0 ..< middleIndex)
    }

    /// The high-order half of this BigUInt.
    ///
    /// - Returns: `self[middleIndex ..< count]`
    /// - Requires: count > 1
    internal var high: BigUInt {
        return self.extract(middleIndex ..< count)
    }
}

