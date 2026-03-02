const fs = require("fs");
const path = require("path");

const POLICY_PATH = path.resolve(__dirname, "../policy/acl-policy.json");

function enforceDirectAccessGuard(argv) {
  const hasPolicy = fs.existsSync(POLICY_PATH);
  const trusted = process.env.ERP_ACL_TRUSTED === "1";

  if (hasPolicy && !trusted) {
    console.error(
      [
        "Error: ACL policy detected. Direct query access is forbidden.",
        "Use secure entry instead:",
        "  node .../secure-query.cjs --wecom-user-id <id> ...",
        "No bypass flags are accepted.",
      ].join("\n"),
    );
    process.exit(1);
  }

  return argv;
}

module.exports = {
  POLICY_PATH,
  enforceDirectAccessGuard,
};
