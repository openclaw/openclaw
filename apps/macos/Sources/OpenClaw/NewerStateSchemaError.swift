import Foundation

/// The bundled CLI refused to open data written by a newer build.
struct NewerStateSchemaError: LocalizedError {
    let required: Int
    let supported: Int

    init?(diagnostic: String) {
        let marker = "uses newer schema version "
        guard let markerRange = diagnostic.range(of: marker),
              let separator = diagnostic[markerRange.upperBound...].range(of: "; this build supports "),
              let required = Int(diagnostic[markerRange.upperBound..<separator.lowerBound]),
              let supported = Int(diagnostic[separator.upperBound...].prefix(while: \.isNumber)),
              required > supported
        else { return nil }
        self.required = required
        self.supported = supported
    }

    var errorDescription: String? {
        "This app supports schema \(self.supported), but your local data requires schema \(self.required). " +
            "Install a compatible OpenClaw app for your Gateway's release channel, then reopen it. " +
            "Do not delete your data or credentials."
    }
}
