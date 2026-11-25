// Static OpenGrep fixtures. These functions are never executed.
import { spawn } from "node:child_process";

async function validatedWithoutSignal(params) {
  await assertSafeUploadSymlinks(params.localDir);
  await new Promise((resolve, reject) => {
    // ok: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function validatedWithSignal(params) {
  await assertSafeUploadSymlinks(params.localDir, params.signal);
  await new Promise((resolve, reject) => {
    // ok: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], { signal: params.signal });
    const remote = spawn("ssh", ["fixture"], { signal: params.signal });
  });
}

async function validatedDirectSpawn(params) {
  await assertSafeUploadSymlinks(params.localDir, params.signal);
  // ok: ssh-sandbox-upload-missing-symlink-boundary-check
  const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
  const remote = spawn("ssh", ["fixture"], {});
}

async function laterValidationDoesNotAuthorizeEarlierUpload(params) {
  let tar;
  // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
  tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
  const remote = spawn("ssh", ["fixture"], {});
  await assertSafeUploadSymlinks(params.localDir);
  // ok: ssh-sandbox-upload-missing-symlink-boundary-check
  tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
}

async function missingValidation(params) {
  await new Promise((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function validationNotAwaited(params) {
  assertSafeUploadSymlinks(params.localDir, params.signal);
  await new Promise((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function validatesOtherDirectory(params, otherDir) {
  await assertSafeUploadSymlinks(otherDir, params.signal);
  await new Promise((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function validatesAfterUpload(params) {
  await new Promise((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
  await assertSafeUploadSymlinks(params.localDir, params.signal);
}

async function arbitraryChecker(params) {
  await inspectDirectory(params.localDir);
  await new Promise((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function conditionalValidation(params, validate) {
  if (validate) {
    await assertSafeUploadSymlinks(params.localDir, params.signal);
  }
  await new Promise((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function swallowedValidationFailure(params) {
  await assertSafeUploadSymlinks(params.localDir, params.signal).catch(() => {});
  await new Promise((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}
