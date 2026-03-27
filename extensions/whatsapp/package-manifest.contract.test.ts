import { describePackageManifestContract } from "../../test/helpers/extensions/package-manifest-contract.js";

describePackageManifestContract({
  pluginId: "whatsapp",
  runtimeDeps: ["@whiskeysockets/baileys", "jimp"],
  minHostVersionBaseline: "2026.3.22",
});
