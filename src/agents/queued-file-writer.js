import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
export function resolveQueuedFileAppendFlags(constants = nodeFs.constants) {
    const noFollow = constants.O_NOFOLLOW;
    return (constants.O_CREAT |
        constants.O_APPEND |
        constants.O_WRONLY |
        (typeof noFollow === "number" ? noFollow : 0));
}
async function assertNoSymlinkParents(filePath) {
    const resolvedDir = path.resolve(path.dirname(filePath));
    const parsed = path.parse(resolvedDir);
    const relativeParts = path.relative(parsed.root, resolvedDir).split(path.sep).filter(Boolean);
    let current = parsed.root;
    for (const part of relativeParts) {
        current = path.join(current, part);
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
            if (path.dirname(current) === parsed.root) {
                continue;
            }
            throw new Error(`Refusing to write queued log under symlinked directory: ${current}`);
        }
        if (!stat.isDirectory()) {
            throw new Error(`Refusing to write queued log under non-directory: ${current}`);
        }
    }
}
function verifyStableOpenedFile(params) {
    if (!params.postOpenStat.isFile()) {
        throw new Error(`Refusing to write queued log to non-file: ${params.filePath}`);
    }
    if (params.postOpenStat.nlink > 1) {
        throw new Error(`Refusing to write queued log to hardlinked file: ${params.filePath}`);
    }
    const pre = params.preOpenStat;
    if (pre && (pre.dev !== params.postOpenStat.dev || pre.ino !== params.postOpenStat.ino)) {
        throw new Error(`Refusing to write queued log after file changed: ${params.filePath}`);
    }
}
async function safeAppendFile(filePath, line, options) {
    await assertNoSymlinkParents(filePath);
    let preOpenStat;
    try {
        const stat = await fs.lstat(filePath);
        if (stat.isSymbolicLink()) {
            throw new Error(`Refusing to write queued log through symlink: ${filePath}`);
        }
        if (!stat.isFile()) {
            throw new Error(`Refusing to write queued log to non-file: ${filePath}`);
        }
        preOpenStat = stat;
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (options.maxFileBytes !== undefined &&
        (preOpenStat?.size ?? 0) + lineBytes > options.maxFileBytes) {
        return;
    }
    const handle = await fs.open(filePath, resolveQueuedFileAppendFlags(), 0o600);
    try {
        const stat = await handle.stat();
        verifyStableOpenedFile({ preOpenStat, postOpenStat: stat, filePath });
        if (options.maxFileBytes !== undefined && stat.size + lineBytes > options.maxFileBytes) {
            return;
        }
        await handle.chmod(0o600);
        await handle.appendFile(line, "utf8");
    }
    finally {
        await handle.close();
    }
}
export function getQueuedFileWriter(writers, filePath, options = {}) {
    const existing = writers.get(filePath);
    if (existing) {
        return existing;
    }
    const dir = path.dirname(filePath);
    const ready = fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
    let queue = Promise.resolve();
    const writer = {
        filePath,
        write: (line) => {
            queue = queue
                .then(() => ready)
                .then(() => safeAppendFile(filePath, line, options))
                .catch(() => undefined);
        },
        flush: async () => {
            await queue;
        },
    };
    writers.set(filePath, writer);
    return writer;
}
