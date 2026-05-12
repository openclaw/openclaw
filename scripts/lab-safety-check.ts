import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const PROTECTED_HOME = path.resolve("/Users/anandsagar/.openclaw");

function isInsideProtectedHome(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return resolved === PROTECTED_HOME || resolved.startsWith(`${PROTECTED_HOME}${path.sep}`);
}

function checkDockerCompose() {
  const overridePath = path.resolve("docker-compose.override.yml");

  if (!fs.existsSync(overridePath)) {
    console.error(
      "ERROR: docker-compose.override.yml is missing. Production data might be at risk!",
    );
    process.exit(1);
  }

  const overrideContent = fs.readFileSync(overridePath, "utf8");
  const override = YAML.parse(overrideContent);

  const services = override.services || {};
  for (const serviceName in services) {
    const volumes = services[serviceName].volumes || [];
    for (const volume of volumes) {
      const hostPath = volume.split(":")[0];
      const resolvedHostPath = path.resolve(hostPath);
      if (isInsideProtectedHome(resolvedHostPath)) {
        console.error(`ERROR: Service ${serviceName} mounts protected path: ${resolvedHostPath}`);
        process.exit(1);
      }
    }
  }

  console.log("Lab safety: Docker mounts are safe.");
}

checkDockerCompose();
