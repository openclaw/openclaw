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
//  Words and Bits.swift
//  BigInt
//
//  Created by Károly Lőrentey on 2017-08-11.
//  Copyright © 2016-2017 Károly Lőrentey.
//

extension Array where Element == UInt {
    mutating func twosComplement() {
        var increment = true
        for i in 0 ..< self.count {
            if increment {
                (self[i], increment) = (~self[i]).addingReportingOverflow(1)
            }
            else {
                self[i] = ~self[i]
            }
        }
    }
}

extension BigUInt {
    public subscript(bitAt index: Int) -> Bool {
        get {
            precondition(index >= 0)
            let (i, j) = index.quotientAndRemainder(dividingBy: Word.bitWidth)
            return self[i] & (1 << j) != 0
        }
        set {
            precondition(index >= 0)
            let (i, j) = index.quotientAndRemainder(dividingBy: Word.bitWidth)
            if newValue {
                self[i] |= 1 << j
            }
            else {
                self[i] &= ~(1 << j)
            }
        }
    }
}

extension BigUInt {
    /// The minimum number of bits required to represent this integer in binary.
    ///
    /// - Returns: floor(log2(2 * self + 1))
    /// - Complexity: O(1)
    public var bitWidth: Int {
        guard count > 0 else { return 0 }
        return count * Word.bitWidth - self[count - 1].leadingZeroBitCount
    }

    /// The number of leading zero bits in the binary representation of this integer in base `2^(Word.bitWidth)`.
    /// This is useful when you need to normalize a `BigUInt` such that the top bit of its most significant word is 1.
    ///
    /// - Note: 0 is considered to have zero leading zero bits.
    /// - Returns: A value in `0...(Word.bitWidth - 1)`.
    /// - SeeAlso: width
    /// - Complexity: O(1)
    public var leadingZeroBitCount: Int {
        guard count > 0 else { return 0 }
        return self[count - 1].leadingZeroBitCount
    }

    /// The number of trailing zero bits in the binary representation of this integer.
    ///
    /// - Note: 0 is considered to have zero trailing zero bits.
    /// - Returns: A value in `0...width`.
    /// - Complexity: O(count)
    public var trailingZeroBitCount: Int {
        guard count > 0 else { return 0 }
        let i = self.words.firstIndex { $0 != 0 }!
        return i * Word.bitWidth + self[i].trailingZeroBitCount
    }
}

extension BigUInt {
    public struct Words: RandomAccessCollection {
        private let value: BigUInt

        fileprivate init(_ value: BigUInt) { self.value = value }

        public var startIndex: Int { return 0 }
        public var endIndex: Int { return value.count }

        public subscript(_ index: Int) -> Word {
            return value[index]
        }
    }

    public var words: Words { return Words(self) }

    public init<Words: Sequence>(words: Words) where Words.Element == Word {
        let uc = words.underestimatedCount
        if uc > 2 {
            self.init(words: Array(words))
        }
        else {
            var it = words.makeIterator()
            guard let w0 = it.next() else {
                self.init()
                return
            }
            guard let w1 = it.next() else {
                self.init(word: w0)
                return
            }
            if let w2 = it.next() {
                var words: [UInt] = []
                words.reserveCapacity(Swift.max(3, uc))
                words.append(w0)
                words.append(w1)
                words.append(w2)
                while let word = it.next() {
                    words.append(word)
                }
                self.init(words: words)
            }
            else {
                self.init(low: w0, high: w1)
            }
        }
    }
}
