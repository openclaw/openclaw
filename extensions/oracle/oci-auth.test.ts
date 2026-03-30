import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOracleAuthenticationDetailsProvider, validateOracleConfigFile } from "./oci-auth.js";

const oracleFixtureDirs: string[] = [];

function writeOracleConfigFixture(params?: { relativeKeyFile?: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oracle-auth-"));
  oracleFixtureDirs.push(dir);

  const profile = "DEFAULT";
  const configFile = path.join(dir, "config");
  const keyFile = path.join(dir, "key.pem");
  const tenancyId = "ocid1.tenancy.oc1..exampletenancy";

  fs.writeFileSync(
    keyFile,
    [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD",
      "-----END PRIVATE KEY-----",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    configFile,
    [
      `[${profile}]`,
      "user=ocid1.user.oc1..exampleuser",
      "fingerprint=11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00",
      `key_file=${params?.relativeKeyFile ? "./key.pem" : keyFile}`,
      `tenancy=${tenancyId}`,
      "region=us-chicago-1",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    configFile,
    keyFile,
    profile,
    tenancyId,
  };
}

afterEach(() => {
  for (const dir of oracleFixtureDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("validateOracleConfigFile", () => {
  it("accepts OCI configs whose key_file path is relative to the config file", () => {
    const fixture = writeOracleConfigFixture({ relativeKeyFile: true });

    expect(validateOracleConfigFile(fixture.configFile, fixture.profile)).toEqual({
      configFile: fixture.configFile,
      profile: fixture.profile,
      compartmentId: fixture.tenancyId,
      tenancyId: fixture.tenancyId,
    });
  });
});

describe("createOracleAuthenticationDetailsProvider", () => {
  it("loads the private key from a relative key_file path", () => {
    const fixture = writeOracleConfigFixture({ relativeKeyFile: true });

    const provider = createOracleAuthenticationDetailsProvider({
      configFile: fixture.configFile,
      profile: fixture.profile,
    });

    expect(provider.getTenantId()).toBe(fixture.tenancyId);
    expect(provider.getPrivateKey()).toContain("BEGIN PRIVATE KEY");
  });
});
