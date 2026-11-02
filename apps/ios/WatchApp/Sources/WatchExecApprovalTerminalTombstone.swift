import Foundation

struct ExecApprovalTerminalTombstone: Equatable {
    var approvalId: String
    var gatewayStableID: String
    var outcome: WatchExecApprovalOutcome
    var outcomeIsAuthoritative: Bool?
    var recordedAt: Date
}

extension ExecApprovalTerminalTombstone: Codable {
    private enum LegacyCodingKeys: String, CodingKey {
        case outcomeText
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.approvalId = try container.decode(String.self, forKey: .approvalId)
        self.gatewayStableID = try container.decode(String.self, forKey: .gatewayStableID)
        self.outcome = try container.decodeIfPresent(
            WatchExecApprovalOutcome.self,
            forKey: .outcome) ?? decoder.container(keyedBy: LegacyCodingKeys.self)
            .decodeIfPresent(String.self, forKey: .outcomeText)
            .flatMap(WatchExecApprovalOutcome.decodeLegacyLocalizedText)
            ?? WatchExecApprovalOutcome(code: .unavailable)
        self.outcomeIsAuthoritative = try container.decodeIfPresent(
            Bool.self,
            forKey: .outcomeIsAuthoritative)
        self.recordedAt = try container.decode(Date.self, forKey: .recordedAt)
    }
}
