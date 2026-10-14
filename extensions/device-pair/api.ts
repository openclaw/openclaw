// Device Pair API module exposes the plugin public contract.
export {
  approveDevicePairing,
  clearDeviceBootstrapTokens,
  issueDeviceBootstrapToken,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  listDevicePairing,
  resolvePairingGatewayUrl,
  revokeDeviceBootstrapToken,
  type DeviceBootstrapProfile,
} from "openclaw/plugin-sdk/device-bootstrap";
export { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export {
  resolvePreferredOpenClawTmpDir,
  runPluginCommandWithTimeout,
} from "openclaw/plugin-sdk/sandbox";
export {
  renderQrPngBase64,
  renderQrPngDataUrl,
  writeQrPngTempFile,
} from "openclaw/plugin-sdk/media-runtime";
