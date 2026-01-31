import Testing
@testable import OpenClaw

struct NodeDisplayNameTests {
    @Test func keepsCustomName() {
        let resolved = NodeDisplayName.resolve(
            existing: "Razor Phone",
            deviceName: "iPhone",
            interfaceIdiom: .phone)
        #expect(resolved == "Razor Phone")
    }

    @Test func usesDeviceNameWhenMatchesIphone() {
        let resolved = NodeDisplayName.resolve(
            existing: "iOS Node",
            deviceName: "iPhone 17 Pro",
            interfaceIdiom: .phone)
        #expect(resolved == "iPhone 17 Pro")
    }

    @Test func usesDefaultWhenDeviceNameIsGeneric() {
        let resolved = NodeDisplayName.resolve(
            existing: nil,
            deviceName: "Work Phone",
            interfaceIdiom: .phone)
        #expect(NodeDisplayName.isGeneric(resolved))
    }

    @Test func identifiesGenericValues() {
        #expect(NodeDisplayName.isGeneric("iOS Node"))
        #expect(NodeDisplayName.isGeneric("iPhone Node"))
        #expect(NodeDisplayName.isGeneric("iPad Node"))
    }
}
