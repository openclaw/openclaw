import Foundation

public enum BonjourEscapes {
    /// mDNS / DNS-SD commonly escapes bytes in instance names as `\DDD` (decimal-encoded),
    /// e.g. spaces are `\032`.
    public static func decode(_ input: String) -> String {
        var out = ""
        var i = input.startIndex
        while i < input.endIndex {
            if input[i] == "\\" {
                let digits = input[input.index(after: i)...].prefix(3)
                if digits.count == 3, digits.allSatisfy(\.isNumber),
                   let value = Int(digits),
                   let scalar = UnicodeScalar(value)
                {
                    out.append(Character(scalar))
                    i = input.index(i, offsetBy: 4)
                    continue
                }
            }

            out.append(input[i])
            i = input.index(after: i)
        }
        return out
    }
}
