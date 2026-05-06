import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOciProfile, OciConfigError } from "./profile-loader.js";

describe("loadOciProfile", () => {
  let workDir: string;
  let configFile: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "oci-profile-loader-"));
    configFile = join(workDir, "config");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("loads a DEFAULT profile with all required fields", async () => {
    await writeFile(
      configFile,
      [
        "[DEFAULT]",
        "user=ocid1.user.oc1..aaaa",
        "tenancy=ocid1.tenancy.oc1..bbbb",
        "fingerprint=ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89",
        "key_file=/etc/oci/key.pem",
        "region=us-chicago-1",
      ].join("\n"),
    );

    const profile = await loadOciProfile({ configFile });

    expect(profile.profileName).toBe("DEFAULT");
    expect(profile.user).toBe("ocid1.user.oc1..aaaa");
    expect(profile.tenancy).toBe("ocid1.tenancy.oc1..bbbb");
    expect(profile.fingerprint).toBe("ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89");
    expect(profile.keyFile).toBe("/etc/oci/key.pem");
    expect(profile.region).toBe("us-chicago-1");
    expect(profile.passPhrase).toBeUndefined();
  });

  it("loads a named profile and ignores DEFAULT", async () => {
    await writeFile(
      configFile,
      [
        "[DEFAULT]",
        "user=ocid1.user.oc1..default",
        "tenancy=ocid1.tenancy.oc1..tnt",
        "fingerprint=00:00",
        "key_file=/etc/oci/default.pem",
        "",
        "[API_FREE_TIER]",
        "user=ocid1.user.oc1..free",
        "tenancy=ocid1.tenancy.oc1..tnt",
        "fingerprint=ff:ff",
        "key_file=/etc/oci/free.pem",
        "region=us-phoenix-1",
        "pass_phrase=secret",
      ].join("\n"),
    );

    const profile = await loadOciProfile({
      configFile,
      profileName: "API_FREE_TIER",
    });

    expect(profile.profileName).toBe("API_FREE_TIER");
    expect(profile.user).toBe("ocid1.user.oc1..free");
    expect(profile.region).toBe("us-phoenix-1");
    expect(profile.passPhrase).toBe("secret");
  });

  it("expands ~/ paths using the supplied homeDir", async () => {
    await writeFile(
      configFile,
      [
        "[DEFAULT]",
        "user=ocid1.user.oc1..aaaa",
        "tenancy=ocid1.tenancy.oc1..bbbb",
        "fingerprint=00:00",
        "key_file=~/keys/oci.pem",
      ].join("\n"),
    );

    const profile = await loadOciProfile({
      configFile,
      homeDir: "/fake/home",
    });

    expect(profile.keyFile).toBe("/fake/home/keys/oci.pem");
  });

  it("ignores comment lines (# and ;) and quoted-string inline comments", async () => {
    await writeFile(
      configFile,
      [
        "# header comment",
        "; another comment",
        "[DEFAULT]",
        "user=ocid1.user.oc1..u  # trailing comment",
        "tenancy=ocid1.tenancy.oc1..t",
        "fingerprint=00:00",
        'key_file="/etc/oci/key #not-a-comment.pem"',
      ].join("\n"),
    );

    const profile = await loadOciProfile({ configFile });

    expect(profile.user).toBe("ocid1.user.oc1..u");
    expect(profile.keyFile).toBe('"/etc/oci/key #not-a-comment.pem"');
  });

  it("throws OciConfigError when the file is missing", async () => {
    await expect(loadOciProfile({ configFile: join(workDir, "missing") })).rejects.toThrow(
      OciConfigError,
    );
  });

  it("throws OciConfigError when the named profile is missing", async () => {
    await writeFile(
      configFile,
      ["[DEFAULT]", "user=u", "tenancy=t", "fingerprint=f", "key_file=/k"].join("\n"),
    );

    await expect(loadOciProfile({ configFile, profileName: "DOES_NOT_EXIST" })).rejects.toThrow(
      /DOES_NOT_EXIST/,
    );
  });

  it("throws OciConfigError when required keys are missing", async () => {
    await writeFile(configFile, ["[DEFAULT]", "user=u", "tenancy=t", "fingerprint=f"].join("\n"));

    await expect(loadOciProfile({ configFile })).rejects.toThrow(/key_file/);
  });
});
