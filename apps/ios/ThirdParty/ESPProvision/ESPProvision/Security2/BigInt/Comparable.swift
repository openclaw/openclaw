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
//  Comparable.swift
//

import Foundation

extension BigUInt: Comparable {
    //MARK: Comparison
    
    /// Compare `a` to `b` and return an `NSComparisonResult` indicating their order.
    ///
    /// - Complexity: O(count)
    public static func compare(_ a: BigUInt, _ b: BigUInt) -> ComparisonResult {
        if a.count != b.count { return a.count > b.count ? .orderedDescending : .orderedAscending }
        for i in (0 ..< a.count).reversed() {
            let ad = a[i]
            let bd = b[i]
            if ad != bd { return ad > bd ? .orderedDescending : .orderedAscending }
        }
        return .orderedSame
    }

    /// Return true iff `a` is equal to `b`.
    ///
    /// - Complexity: O(count)
    public static func ==(a: BigUInt, b: BigUInt) -> Bool {
        return BigUInt.compare(a, b) == .orderedSame
    }

    /// Return true iff `a` is less than `b`.
    ///
    /// - Complexity: O(count)
    public static func <(a: BigUInt, b: BigUInt) -> Bool {
        return BigUInt.compare(a, b) == .orderedAscending
    }
}


