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
//  Addition.swift
//

extension BigUInt {
    //MARK: Addition
    
    /// Add `word` to this integer in place.
    /// `word` is shifted `shift` words to the left before being added.
    ///
    /// - Complexity: O(max(count, shift))
    internal mutating func addWord(_ word: Word, shiftedBy shift: Int = 0) {
        precondition(shift >= 0)
        var carry = word
        var i = shift
        while carry > 0 {
            let (d, c) = self[i].addingReportingOverflow(carry)
            self[i] = d
            carry = (c ? 1 : 0)
            i += 1
        }
    }

    /// Add the digit `d` to this integer and return the result.
    /// `d` is shifted `shift` words to the left before being added.
    ///
    /// - Complexity: O(max(count, shift))
    internal func addingWord(_ word: Word, shiftedBy shift: Int = 0) -> BigUInt {
        var r = self
        r.addWord(word, shiftedBy: shift)
        return r
    }

    /// Add `b` to this integer in place.
    /// `b` is shifted `shift` words to the left before being added.
    ///
    /// - Complexity: O(max(count, b.count + shift))
    internal mutating func add(_ b: BigUInt, shiftedBy shift: Int = 0) {
        precondition(shift >= 0)
        var carry = false
        var bi = 0
        let bc = b.count
        while bi < bc || carry {
            let ai = shift + bi
            let (d, c) = self[ai].addingReportingOverflow(b[bi])
            if carry {
                let (d2, c2) = d.addingReportingOverflow(1)
                self[ai] = d2
                carry = c || c2
            }
            else {
                self[ai] = d
                carry = c
            }
            bi += 1
        }
    }

    /// Add `b` to this integer and return the result.
    /// `b` is shifted `shift` words to the left before being added.
    ///
    /// - Complexity: O(max(count, b.count + shift))
    internal func adding(_ b: BigUInt, shiftedBy shift: Int = 0) -> BigUInt {
        var r = self
        r.add(b, shiftedBy: shift)
        return r
    }

    /// Increment this integer by one. If `shift` is non-zero, it selects
    /// the word that is to be incremented.
    ///
    /// - Complexity: O(count + shift)
    internal mutating func increment(shiftedBy shift: Int = 0) {
        self.addWord(1, shiftedBy: shift)
    }

    /// Add `a` and `b` together and return the result.
    ///
    /// - Complexity: O(max(a.count, b.count))
    public static func +(a: BigUInt, b: BigUInt) -> BigUInt {
        return a.adding(b)
    }

    /// Add `a` and `b` together, and store the sum in `a`.
    ///
    /// - Complexity: O(max(a.count, b.count))
    public static func +=(a: inout BigUInt, b: BigUInt) {
        a.add(b, shiftedBy: 0)
    }
}

