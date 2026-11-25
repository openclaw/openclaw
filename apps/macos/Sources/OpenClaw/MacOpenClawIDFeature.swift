import OpenClawKit

/// OpenClaw ID entry points appear only in builds that package the native transport
/// (`OPENCLAW_IROH_NATIVE=1`); other builds hide the feature entirely.
enum MacOpenClawIDFeature {
    static var isEnabled: Bool {
        OpenClawIDNodeNativeEndpoint.isPackaged
    }
}
