// Static OpenGrep fixtures. These functions are never executed.
import { spawn, type ChildProcess } from "node:child_process";

type Upload = { localDir: string; signal?: AbortSignal };
declare function assertSafeUploadSymlinks(localDir: string, signal?: AbortSignal): Promise<void>;
declare function inspectDirectory(localDir: string): Promise<void>;

async function validatedWithoutSignal(params: Upload) {
  await assertSafeUploadSymlinks(params.localDir);
  await new Promise<void>((resolve, reject) => {
    // ok: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function validatedWithSignal(params: Upload) {
  await assertSafeUploadSymlinks(params.localDir, params.signal);
  await new Promise<void>((resolve, reject) => {
    // ok: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar: ChildProcess = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {
      signal: params.signal,
    });
    const remote: ChildProcess = spawn("ssh", ["fixture"], { signal: params.signal });
  });
}

async function validatedDirectSpawn(params: Upload) {
  await assertSafeUploadSymlinks(params.localDir, params.signal);
  // ok: ssh-sandbox-upload-missing-symlink-boundary-check
  const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
  const remote = spawn("ssh", ["fixture"], {});
}

async function laterValidationDoesNotAuthorizeEarlierUpload(params: Upload) {
  let tar: ChildProcess;
  // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
  tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
  const remote = spawn("ssh", ["fixture"], {});
  await assertSafeUploadSymlinks(params.localDir);
  // ok: ssh-sandbox-upload-missing-symlink-boundary-check
  tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
}

async function missingValidation(params: Upload) {
  await new Promise<void>((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function validationNotAwaited(params: Upload) {
  assertSafeUploadSymlinks(params.localDir, params.signal);
  await new Promise<void>((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function validatesOtherDirectory(params: Upload, otherDir: string) {
  await assertSafeUploadSymlinks(otherDir, params.signal);
  await new Promise<void>((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function validatesAfterUpload(params: Upload) {
  await new Promise<void>((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
  await assertSafeUploadSymlinks(params.localDir, params.signal);
}

async function arbitraryChecker(params: Upload) {
  await inspectDirectory(params.localDir);
  await new Promise<void>((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function conditionalValidation(params: Upload, validate: boolean) {
  if (validate) {
    await assertSafeUploadSymlinks(params.localDir, params.signal);
  }
  await new Promise<void>((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}

async function swallowedValidationFailure(params: Upload) {
  await assertSafeUploadSymlinks(params.localDir, params.signal).catch(() => {});
  await new Promise<void>((resolve, reject) => {
    // ruleid: ssh-sandbox-upload-missing-symlink-boundary-check
    const tar = spawn("tar", ["-C", params.localDir, "-cf", "-", "."], {});
    const remote = spawn("ssh", ["fixture"], {});
  });
}
