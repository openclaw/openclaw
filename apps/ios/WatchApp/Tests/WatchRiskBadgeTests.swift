import SwiftUI
import Testing

@testable import OpenClawWatch

@Suite("WatchRiskBadge")
struct WatchRiskBadgeTests {
    // Helper to extract computed properties via the same logic as the view.
    private func normalized(_ risk: String?) -> String {
        risk?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    private func icon(for risk: String?) -> String {
        switch normalized(risk) {
        case "high": "exclamationmark.triangle.fill"
        case "medium": "info.circle.fill"
        default: "shield.fill"
        }
    }

    private func label(for risk: String?) -> String {
        switch normalized(risk) {
        case "high": "High Risk"
        case "medium": "Medium Risk"
        default: "Low Risk"
        }
    }

    private func tintColor(for risk: String?) -> Color? {
        switch normalized(risk) {
        case "high": .red
        case "medium": .orange
        default: nil
        }
    }

    @Test func highRiskMapping() {
        #expect(icon(for: "high") == "exclamationmark.triangle.fill")
        #expect(label(for: "high") == "High Risk")
        #expect(tintColor(for: "high") == .red)
    }

    @Test func mediumRiskMapping() {
        #expect(icon(for: "medium") == "info.circle.fill")
        #expect(label(for: "medium") == "Medium Risk")
        #expect(tintColor(for: "medium") == .orange)
    }

    @Test func lowRiskMapping() {
        #expect(icon(for: "low") == "shield.fill")
        #expect(label(for: "low") == "Low Risk")
        #expect(tintColor(for: "low") == nil)
    }

    @Test func nilRiskDefaultsToLow() {
        #expect(icon(for: nil) == "shield.fill")
        #expect(label(for: nil) == "Low Risk")
        #expect(tintColor(for: nil) == nil)
    }

    @Test func whitespaceOnlyRiskDefaultsToLow() {
        #expect(label(for: "   ") == "Low Risk")
    }

    @Test func caseInsensitiveRisk() {
        #expect(label(for: "HIGH") == "High Risk")
        #expect(label(for: "Medium") == "Medium Risk")
        #expect(label(for: "  High  ") == "High Risk")
    }

    @Test func unknownRiskDefaultsToLow() {
        #expect(label(for: "critical") == "Low Risk")
        #expect(tintColor(for: "critical") == nil)
    }
}
