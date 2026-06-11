/*!
 * chokidar-slim — a single-file, OpenClaw-owned trim of chokidar.
 * DO NOT EDIT THIS IF POSSIBLE.
 *
 * Sources: chokidar v5.0.0 `src/index.ts` + `src/handler.ts`, with the small
 * readdirp traversal it used folded in. MIT License, (c) 2012 Paul Miller.
 * Trimmed for OpenClaw callers and extended with addAsync/whenReady/watchAsync.
 */
import { EventEmitter } from "node:events";
import {
  type FSWatcher as NativeFsWatcher,
  type Stats,
  stat as statcb,
  unwatchFile,
  watch as fs_watch,
  watchFile,
  type WatchListener,
} from "node:fs";
import { lstat, open, readdir, realpath as fsrealpath, stat } from "node:fs/promises";
import { type as osType } from "node:os";
import * as sp from "node:path";
import { Readable } from "node:stream";

export type Path = string;

const STR_DATA = "data";
const STR_END = "end";
const STR_CLOSE = "close";
const EMPTY_FN = (): void => {};

const pl = process.platform;
const isWindows: boolean = pl === "win32";
const isMacos: boolean = pl === "darwin";
const isLinux: boolean = pl === "linux";
const isFreeBSD: boolean = pl === "freebsd";
const isIBMi = osType() === "OS400";

export const EVENTS = {
  ALL: "all",
  READY: "ready",
  ADD: "add",
  CHANGE: "change",
  ADD_DIR: "addDir",
  UNLINK: "unlink",
  UNLINK_DIR: "unlinkDir",
  ERROR: "error",
} as const;
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

const EV = EVENTS;
const THROTTLE_MODE_WATCH = "watch";

export interface EntryInfo {
  path: string;
  fullPath: string;
  stats: Stats;
  basename: string;
}

type ReaddirpFilter = (entryInfo: EntryInfo) => boolean;
type ReaddirpOptions = {
  fileFilter?: ReaddirpFilter;
  directoryFilter?: ReaddirpFilter;
  lstat?: boolean;
  highWaterMark?: number;
};

const RECURSIVE_ERROR_CODE = "READDIRP_RECURSIVE_ERROR";
const NORMAL_READDIR_ERRORS = new Set(["ENOENT", "EPERM", "EACCES", "ELOOP", RECURSIVE_ERROR_CODE]);
const TRUE_FILTER: ReaddirpFilter = () => true;

const hasErrorCode = (error: unknown): error is Error & { code: string } =>
  error instanceof Error && "code" in error && typeof error.code === "string";

class ReaddirpStream extends Readable {
  reading: boolean;

  private readonly fileFilter: ReaddirpFilter;
  private readonly directoryFilter: ReaddirpFilter;
  private files?: string[];
  private readonly root: Path;
  private readonly statMethod: typeof lstat;

  constructor(root: Path, options: Partial<ReaddirpOptions> = {}) {
    super({
      objectMode: true,
      autoDestroy: true,
      highWaterMark: options.highWaterMark,
    });

    this.fileFilter = options.fileFilter ?? TRUE_FILTER;
    this.directoryFilter = options.directoryFilter ?? TRUE_FILTER;
    this.root = sp.resolve(root);
    this.statMethod = options.lstat ? lstat : stat;
    this.reading = false;
  }

  async _read(batch: number): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      while (!this.destroyed && batch > 0) {
        this.files ??= await this.exploreDir();
        if (this.files.length === 0) {
          this.push(null);
          break;
        }

        const entries = await Promise.all(
          this.files.splice(0, batch).map((name) => this.formatEntry(name)),
        );
        for (const entry of entries) {
          if (!entry || this.destroyed) continue;
          const entryType = await this.getEntryType(entry);
          const filter = entryType === "directory" ? this.directoryFilter : this.fileFilter;
          if (filter(entry)) {
            this.push(entry);
            batch--;
          }
        }
      }
    } catch (error) {
      this.destroy(error as Error);
    } finally {
      this.reading = false;
    }
  }

  private async exploreDir(): Promise<string[]> {
    try {
      return await readdir(this.root);
    } catch (error) {
      this.onReaddirError(error);
      return [];
    }
  }

  private async formatEntry(basename: string): Promise<EntryInfo | undefined> {
    try {
      const fullPath = sp.join(this.root, basename);
      return {
        path: sp.relative(this.root, fullPath),
        fullPath,
        basename,
        stats: await this.statMethod(fullPath),
      };
    } catch (error) {
      this.onReaddirError(error);
      return undefined;
    }
  }

  private onReaddirError(error: unknown): void {
    if (hasErrorCode(error) && NORMAL_READDIR_ERRORS.has(error.code) && !this.destroyed) {
      this.emit("warn", error);
    } else {
      this.destroy(error as Error);
    }
  }

  private async getEntryType(entry: EntryInfo): Promise<"file" | "directory" | undefined> {
    const { stats } = entry;
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    if (!stats.isSymbolicLink()) return undefined;

    try {
      const targetPath = await fsrealpath(entry.fullPath);
      const targetStats = await lstat(targetPath);
      if (targetStats.isFile()) return "file";
      if (targetStats.isDirectory()) {
        const targetPrefixLength = targetPath.length;
        if (
          entry.fullPath.startsWith(targetPath) &&
          entry.fullPath.substring(targetPrefixLength, targetPrefixLength + 1) === sp.sep
        ) {
          const recursiveError = new Error(
            `Circular symlink detected: "${entry.fullPath}" points to "${targetPath}"`,
          ) as Error & { code: string };
          recursiveError.code = RECURSIVE_ERROR_CODE;
          this.onReaddirError(recursiveError);
          return undefined;
        }
        return "directory";
      }
    } catch (error) {
      this.onReaddirError(error);
    }
    return undefined;
  }
}

const statMethods = { lstat, stat };

const KEY_LISTENERS = "listeners";
const KEY_ERR = "errHandlers";
const HANDLER_KEYS = [KEY_LISTENERS, KEY_ERR];

// fs_watch helpers

const foreach = <V>(val: V | Set<V>, fn: (arg: V) => unknown) => {
  if (val instanceof Set) {
    val.forEach(fn);
  } else {
    fn(val);
  }
};

const addAndConvert = (main: Record<string, unknown>, prop: string, item: unknown) => {
  let container = main[prop];
  if (!(container instanceof Set)) {
    main[prop] = container = new Set([container]);
  }
  (container as Set<unknown>).add(item);
};

const clearItem = (cont: Record<string, unknown>) => (key: string) => {
  const set = cont[key];
  if (set instanceof Set) {
    set.clear();
  } else {
    delete cont[key];
  }
};

const delFromSet = (main: Record<string, unknown>, prop: string, item: unknown) => {
  const container = main[prop];
  if (container instanceof Set) {
    container.delete(item);
  } else if (container === item) {
    delete main[prop];
  }
};

const isEmptySet = (val: unknown) => (val instanceof Set ? val.size === 0 : !val);

// object to hold per-process fs_watch instances
// (may be shared across chokidar FSWatcher instances)
export type FsWatchContainer = {
  listeners: ((path: string) => void) | Set<(path: string) => void>;
  errHandlers: ((err: unknown) => void) | Set<(err: unknown) => void>;
  watcher: NativeFsWatcher;
  watcherUnusable?: boolean;
};

const FsWatchInstances = new Map<string, FsWatchContainer>();

/**
 * Instantiates the fs_watch interface
 * @param path to be watched
 * @param listener main event handler
 * @param errHandler emits info about errors
 */
function createFsWatchInstance(
  path: string,
  options: Partial<FSWInstanceOptions>,
  listener: WatchHandlers["listener"],
  errHandler: WatchHandlers["errHandler"],
): NativeFsWatcher | undefined {
  const handleEvent: WatchListener<string> = (_rawEvent, evPath) => {
    listener(path);

    // emit based on events occurring for files from a directory's watcher in
    // case the file's watcher misses it (and rely on throttling to de-dupe)
    if (evPath && path !== evPath) {
      fsWatchBroadcast(sp.resolve(path, evPath), KEY_LISTENERS, sp.join(path, evPath));
    }
  };
  try {
    return fs_watch(path, { persistent: options.persistent }, handleEvent);
  } catch (error) {
    errHandler(error);
    return undefined;
  }
}

/**
 * Helper for passing fs_watch event data to a collection of listeners
 * @param fullPath absolute path bound to fs_watch instance
 */
const fsWatchBroadcast = (fullPath: Path, listenerType: string, val1?: unknown) => {
  const cont = FsWatchInstances.get(fullPath);
  if (!cont) return;
  foreach(cont[listenerType as keyof typeof cont] as never, (listener: (v?: unknown) => void) => {
    listener(val1);
  });
};

export interface WatchHandlers {
  listener: (path: string) => void;
  errHandler: (err: unknown) => void;
}

/**
 * Instantiates the fs_watch interface or binds listeners
 * to an existing one covering the same file system entry
 */
const setFsWatchListener = (
  path: string,
  fullPath: string,
  options: Partial<FSWInstanceOptions>,
  handlers: WatchHandlers,
): (() => void) | undefined => {
  const { listener, errHandler } = handlers;
  let cont = FsWatchInstances.get(fullPath);

  let watcher: NativeFsWatcher | undefined;
  if (cont) {
    addAndConvert(cont as unknown as Record<string, unknown>, KEY_LISTENERS, listener);
    addAndConvert(cont as unknown as Record<string, unknown>, KEY_ERR, errHandler);
  } else {
    watcher = createFsWatchInstance(
      path,
      options,
      fsWatchBroadcast.bind(null, fullPath, KEY_LISTENERS),
      errHandler, // no need to use broadcast here
    );
    if (!watcher) return;
    watcher.on(EV.ERROR, async (error: Error & { code: string }) => {
      const broadcastErr = fsWatchBroadcast.bind(null, fullPath, KEY_ERR);
      if (cont) cont.watcherUnusable = true; // documented since Node 10.4.1
      // Workaround for https://github.com/joyent/node/issues/4337
      if (isWindows && error.code === "EPERM") {
        try {
          const fd = await open(path, "r");
          await fd.close();
          broadcastErr(error);
        } catch {
          // do nothing
        }
      } else {
        broadcastErr(error);
      }
    });
    cont = {
      listeners: listener,
      errHandlers: errHandler,
      watcher,
    };
    FsWatchInstances.set(fullPath, cont);
  }

  // removes this instance's listeners and closes the underlying fs_watch
  // instance if there are no more listeners left
  return () => {
    delFromSet(cont as unknown as Record<string, unknown>, KEY_LISTENERS, listener);
    delFromSet(cont as unknown as Record<string, unknown>, KEY_ERR, errHandler);
    if (isEmptySet(cont.listeners)) {
      // Check to protect against issue gh-730.
      cont.watcher.close();
      FsWatchInstances.delete(fullPath);
      HANDLER_KEYS.forEach(clearItem(cont as unknown as Record<string, unknown>));
      cont.watcher = undefined as unknown as NativeFsWatcher;
      Object.freeze(cont);
    }
  };
};

// fs_watchFile helpers

// object to hold per-process fs_watchFile instances
// (may be shared across chokidar FSWatcher instances)
const FsWatchFileInstances = new Map<string, any>();

/**
 * Instantiates the fs_watchFile interface or binds listeners
 * to an existing one covering the same file system entry
 * @returns closer
 */
const setFsWatchFileListener = (
  path: Path,
  fullPath: Path,
  options: Partial<FSWInstanceOptions>,
  handlers: Pick<WatchHandlers, "listener">,
): (() => void) => {
  const { listener } = handlers;
  let cont = FsWatchFileInstances.get(fullPath);

  const copts = cont && cont.options;
  if (copts && (copts.persistent < options.persistent! || copts.interval > options.interval!)) {
    // "Upgrade" the watcher to persistence or a quicker interval.
    // This creates some unlikely edge case issues if the user mixes
    // settings in a very weird way, but solving for those cases
    // doesn't seem worthwhile for the added complexity.
    unwatchFile(fullPath);
    cont = undefined;
  }

  if (cont) {
    addAndConvert(cont, KEY_LISTENERS, listener);
  } else {
    cont = {
      listeners: listener,
      options,
      watcher: watchFile(fullPath, options, (curr, prev) => {
        const currmtime = curr.mtimeMs;
        if (curr.size !== prev.size || currmtime > prev.mtimeMs || currmtime === 0) {
          foreach(cont.listeners, (listener: (p: Path, s: Stats) => void) => listener(path, curr));
        }
      }),
    };
    FsWatchFileInstances.set(fullPath, cont);
  }

  // Removes this instance's listeners and closes the underlying fs_watchFile
  // instance if there are no more listeners left.
  return () => {
    delFromSet(cont, KEY_LISTENERS, listener);
    if (isEmptySet(cont.listeners)) {
      FsWatchFileInstances.delete(fullPath);
      unwatchFile(fullPath);
      cont.options = cont.watcher = undefined;
      Object.freeze(cont);
    }
  };
};

export class NodeFsHandler {
  fsw: FSWatcher;
  _boundHandleError: (error: unknown) => void;
  constructor(fsW: FSWatcher) {
    this.fsw = fsW;
    this._boundHandleError = (error) => fsW._handleError(error as Error);
  }

  /**
   * Watch file for changes with fs_watchFile or fs_watch.
   * @returns closer for the watcher instance
   */
  _watchWithNodeFs(
    path: string,
    listener: (path: string, newStats?: Stats) => void | Promise<void>,
  ): (() => void) | undefined {
    const opts = this.fsw.options;
    const directory = sp.dirname(path);
    const basename = sp.basename(path);
    const parent = this.fsw._getWatchedDir(directory);
    parent.add(basename);
    const absolutePath = sp.resolve(path);
    const options: Partial<FSWInstanceOptions> = { persistent: opts.persistent };
    if (!listener) listener = EMPTY_FN;

    let closer;
    if (opts.usePolling) {
      options.interval = opts.interval;
      closer = setFsWatchFileListener(path, absolutePath, options, { listener });
    } else {
      closer = setFsWatchListener(path, absolutePath, options, {
        listener,
        errHandler: this._boundHandleError,
      });
    }
    return closer;
  }

  /**
   * Watch a file and emit add event if warranted.
   * @returns closer for the watcher instance
   */
  _handleFile(file: Path, stats: Stats, initialAdd: boolean): (() => void) | undefined {
    if (this.fsw.closed) {
      return;
    }
    const dirname = sp.dirname(file);
    const basename = sp.basename(file);
    const parent = this.fsw._getWatchedDir(dirname);
    // stats is always present
    let prevStats = stats;

    // if the file is already being watched, do nothing
    if (parent.has(basename)) return;

    const listener = async (path: Path, newStats?: Stats) => {
      if (!this.fsw._throttle(THROTTLE_MODE_WATCH, file, 5)) return;
      if (!newStats || newStats.mtimeMs === 0) {
        try {
          const newStats = await stat(file);
          if (this.fsw.closed) return;
          // Check that change event was not fired because of changed only accessTime.
          const at = newStats.atimeMs;
          const mt = newStats.mtimeMs;
          if (!at || at <= mt || mt !== prevStats.mtimeMs) {
            this.fsw._emit(EV.CHANGE, file, newStats);
          }
          if ((isMacos || isLinux || isFreeBSD) && prevStats.ino !== newStats.ino) {
            this.fsw._closeFile(path);
            prevStats = newStats;
            const closer = this._watchWithNodeFs(file, listener);
            if (closer) this.fsw._addPathCloser(path, closer);
          } else {
            prevStats = newStats;
          }
        } catch {
          // Fix issues where mtime is null but file is still present
          this.fsw._remove(dirname, basename);
        }
        // add is about to be emitted if file not already tracked in parent
      } else if (parent.has(basename)) {
        // Check that change event was not fired because of changed only accessTime.
        const at = newStats.atimeMs;
        const mt = newStats.mtimeMs;
        if (!at || at <= mt || mt !== prevStats.mtimeMs) {
          this.fsw._emit(EV.CHANGE, file, newStats);
        }
        prevStats = newStats;
      }
    };
    // kick off the watcher
    const closer = this._watchWithNodeFs(file, listener);

    // emit an add event if we're supposed to
    if (!(initialAdd && this.fsw.options.ignoreInitial) && this.fsw._isntIgnored(file)) {
      if (!this.fsw._throttle(EV.ADD, file, 0)) return;
      this.fsw._emit(EV.ADD, file, stats);
    }

    return closer;
  }

  /**
   * Handle symlinks encountered while reading a dir.
   * @returns true if no more processing is needed for this entry.
   */
  async _handleSymlink(
    entry: EntryInfo,
    directory: string,
    path: Path,
    item: string,
  ): Promise<boolean | undefined> {
    if (this.fsw.closed) {
      return;
    }
    const full = entry.fullPath;
    const dir = this.fsw._getWatchedDir(directory);

    if (!this.fsw.options.followSymlinks) {
      // watch symlink directly (don't follow) and detect changes
      this.fsw._incrReadyCount();

      let linkPath;
      try {
        linkPath = await fsrealpath(path);
      } catch {
        this.fsw._emitReady();
        return true;
      }

      if (this.fsw.closed) return;
      if (dir.has(item)) {
        if (this.fsw._symlinkPaths.get(full) !== linkPath) {
          this.fsw._symlinkPaths.set(full, linkPath);
          this.fsw._emit(EV.CHANGE, path, entry.stats);
        }
      } else {
        dir.add(item);
        this.fsw._symlinkPaths.set(full, linkPath);
        this.fsw._emit(EV.ADD, path, entry.stats);
      }
      this.fsw._emitReady();
      return true;
    }

    // don't follow the same symlink more than once
    if (this.fsw._symlinkPaths.has(full)) {
      return true;
    }

    this.fsw._symlinkPaths.set(full, true);
    return undefined;
  }

  _handleRead(
    directory: string,
    initialAdd: boolean,
    wh: WatchHelper,
    target: Path | undefined,
    dir: Path,
    depth: number,
    throttler: Throttler,
  ): Promise<unknown> | undefined {
    // Normalize the directory name on Windows
    directory = sp.join(directory, "");

    const throttleKey = target ? `${directory}:${target}` : directory;
    throttler = this.fsw._throttle("readdir", throttleKey, 1000) as Throttler;
    if (!throttler) return;

    const previous = this.fsw._getWatchedDir(wh.path);
    const current = new Set<string>();
    const pendingEntries: Array<Promise<void>> = [];

    let stream = this.fsw._readdirp(directory, {
      fileFilter: (entry: EntryInfo) => wh.filterPath(entry),
      directoryFilter: (entry: EntryInfo) => wh.filterDir(entry),
    });
    if (!stream) return;
    stream
      .on(STR_DATA, (entry) => {
        const pendingEntry = (async () => {
          if (this.fsw.closed) {
            stream = undefined;
            return;
          }
          const item = entry.path;
          let path = sp.join(directory, item);
          current.add(item);

          if (
            entry.stats.isSymbolicLink() &&
            (await this._handleSymlink(entry, directory, path, item))
          ) {
            return;
          }

          if (this.fsw.closed) {
            stream = undefined;
            return;
          }
          // Files that present in current directory snapshot
          // but absent in previous are added to watch list and
          // emit `add` event.
          if (item === target || (!target && !previous.has(item))) {
            this.fsw._incrReadyCount();

            // ensure relativeness of path is preserved in case of watcher reuse
            path = sp.join(dir, sp.relative(dir, path));

            await this._addToNodeFs(path, initialAdd, wh, depth + 1);
          }
        })();
        pendingEntries.push(pendingEntry);
        void pendingEntry.catch(() => undefined);
      })
      .on(EV.ERROR, this._boundHandleError);

    return new Promise((resolve, reject) => {
      if (!stream) return reject();
      stream.once(STR_END, async () => {
        if (this.fsw.closed) {
          stream = undefined;
          return;
        }
        try {
          await Promise.all(pendingEntries);
        } catch (error) {
          reject(error);
          return;
        }
        const wasThrottled = throttler ? throttler.clear() : false;

        resolve(undefined);

        // Files that absent in current directory snapshot
        // but present in previous emit `remove` event
        // and are removed from @watched[directory].
        previous
          .getChildren()
          .filter((item) => {
            return item !== directory && !current.has(item);
          })
          .forEach((item) => {
            this.fsw._remove(directory, item);
          });

        stream = undefined;

        // one more time for any missed in case changes came in extremely quickly
        if (wasThrottled) this._handleRead(directory, false, wh, target, dir, depth, throttler);
      });
    });
  }

  /**
   * Read directory to add / remove files from `@watched` list and re-read it on change.
   * @returns closer for the watcher instance.
   */
  async _handleDir(
    dir: string,
    stats: Stats,
    initialAdd: boolean,
    depth: number,
    target: string | undefined,
    wh: WatchHelper,
    realpath: string,
  ): Promise<(() => void) | undefined> {
    const parentDir = this.fsw._getWatchedDir(sp.dirname(dir));
    const tracked = parentDir.has(sp.basename(dir));
    if (!(initialAdd && this.fsw.options.ignoreInitial) && !target && !tracked) {
      this.fsw._emit(EV.ADD_DIR, dir, stats);
    }

    // ensure dir is tracked (harmless if redundant)
    parentDir.add(sp.basename(dir));
    this.fsw._getWatchedDir(dir);
    let throttler!: Throttler;
    let closer;

    const oDepth = this.fsw.options.depth;
    if ((oDepth == null || depth <= oDepth) && !this.fsw._symlinkPaths.has(realpath)) {
      if (!target) {
        await this._handleRead(dir, initialAdd, wh, target, dir, depth, throttler);
        if (this.fsw.closed) return;
      }

      closer = this._watchWithNodeFs(dir, (dirPath, stats) => {
        // if current directory is removed, do nothing
        if (stats && stats.mtimeMs === 0) return;

        this._handleRead(dirPath, false, wh, target, dir, depth, throttler);
      });
    }
    return closer;
  }

  /**
   * Handle added file, directory, or glob pattern.
   * Delegates call to _handleFile / _handleDir after checks.
   * @param path to file or dir
   * @param initialAdd was the file added at watch instantiation?
   * @param priorWh depth relative to user-supplied path
   * @param depth Child path actually targeted for watch
   * @param target Child path actually targeted for watch
   */
  async _addToNodeFs(
    path: string,
    initialAdd: boolean,
    priorWh: WatchHelper | undefined,
    depth: number,
    target?: string,
  ): Promise<string | false | undefined> {
    const ready = this.fsw._emitReady;
    if (this.fsw._isIgnored(path) || this.fsw.closed) {
      ready();
      return false;
    }

    const wh = this.fsw._getWatchHelpers(path);
    if (priorWh) {
      wh.filterPath = (entry) => priorWh.filterPath(entry);
      wh.filterDir = (entry) => priorWh.filterDir(entry);
    }

    // evaluate what is at the path we're being asked to watch
    try {
      const stats = await statMethods[wh.statMethod](wh.watchPath);
      if (this.fsw.closed) return;
      if (this.fsw._isIgnored(wh.watchPath, stats)) {
        ready();
        return false;
      }

      const follow = this.fsw.options.followSymlinks;
      let closer;
      if (stats.isDirectory()) {
        const absPath = sp.resolve(path);
        const targetPath = follow ? await fsrealpath(path) : path;
        if (this.fsw.closed) return;
        closer = await this._handleDir(
          wh.watchPath,
          stats,
          initialAdd,
          depth,
          target,
          wh,
          targetPath,
        );
        if (this.fsw.closed) return;
        // preserve this symlink's target path
        if (absPath !== targetPath && targetPath !== undefined) {
          this.fsw._symlinkPaths.set(absPath, targetPath);
        }
      } else if (stats.isSymbolicLink()) {
        const targetPath = follow ? await fsrealpath(path) : path;
        if (this.fsw.closed) return;
        const parent = sp.dirname(wh.watchPath);
        this.fsw._getWatchedDir(parent).add(wh.watchPath);
        this.fsw._emit(EV.ADD, wh.watchPath, stats);
        closer = await this._handleDir(parent, stats, initialAdd, depth, path, wh, targetPath);
        if (this.fsw.closed) return;

        // preserve this symlink's target path
        if (targetPath !== undefined) {
          this.fsw._symlinkPaths.set(sp.resolve(path), targetPath);
        }
      } else {
        closer = this._handleFile(wh.watchPath, stats, initialAdd);
      }
      ready();

      if (closer) this.fsw._addPathCloser(path, closer);
      return false;
    } catch (error) {
      if (this.fsw._handleError(error as Error)) {
        ready();
        return path;
      }
    }
    return undefined;
  }
}

// FSWatcher

export type AWF = {
  stabilityThreshold: number;
  pollInterval: number;
};

type BasicOpts = {
  persistent: boolean;
  ignoreInitial: boolean;
  followSymlinks: boolean;
  // Polling
  usePolling: boolean;
  interval: number;
  depth?: number;
  atomic: boolean | number; // or a custom 'atomicity delay', in milliseconds (default 100)
};

export type Throttler = {
  timeoutObject: NodeJS.Timeout;
  clear: () => number;
  count: number;
};

export type ChokidarOptions = Partial<
  BasicOpts & {
    ignored: Matcher | Matcher[];
    awaitWriteFinish: boolean | Partial<AWF>;
  }
>;

export type FSWInstanceOptions = BasicOpts & {
  ignored: Matcher[];
  awaitWriteFinish: false | AWF;
};

export type ThrottleType = "readdir" | "watch" | "add" | "remove" | "change";
export type EmitArgs = [path: Path, stats?: Stats];
export type EmitArgsWithName = [event: EventName, ...EmitArgs];
export type MatchFunction = (val: string, stats?: Stats) => boolean;
export type Matcher = string | RegExp | MatchFunction;

type PendingWrite = {
  lastChange: number;
  cancelWait: () => EventName;
};

const ONE_DOT = ".";
const TWO_DOTS = "..";
const STRING_TYPE = "string";
const BACK_SLASH_RE = /\\/g;
const DOUBLE_SLASH_RE = /\/\//g;
const DOT_RE = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;
const REPLACER_RE = /^\.[/\\]/;
const SLASH = "/";
const SLASH_SLASH = "//";

function arrify<T>(item: T | T[]): T[] {
  return Array.isArray(item) ? item : [item];
}

function createPattern(matcher: Matcher): MatchFunction {
  if (typeof matcher === "function") return matcher;
  if (typeof matcher === "string") return (string) => matcher === string;
  if (matcher instanceof RegExp) return (string) => matcher.test(string);
  return () => false;
}

function normalizePath(path: Path): Path {
  if (typeof path !== "string") throw new Error("string expected");
  path = sp.normalize(path);
  path = path.replace(/\\/g, "/");
  let prepend = false;
  if (path.startsWith("//")) prepend = true;
  path = path.replace(DOUBLE_SLASH_RE, "/");
  if (prepend) path = "/" + path;
  return path;
}

function matchPatterns(patterns: MatchFunction[], testString: string, stats?: Stats): boolean {
  const path = normalizePath(testString);

  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index];
    if (pattern(path, stats)) {
      return true;
    }
  }

  return false;
}

function anymatch(matchers: Matcher[], testString: undefined): MatchFunction;
function anymatch(matchers: Matcher[], testString: string): boolean;
function anymatch(matchers: Matcher[], testString: string | undefined): boolean | MatchFunction {
  if (matchers == null) {
    throw new TypeError("anymatch: specify first argument");
  }

  // Early cache for matchers.
  const matchersArray = arrify(matchers);
  const patterns = matchersArray.map((matcher) => createPattern(matcher));

  if (testString == null) {
    return (testString: string, stats?: Stats): boolean => {
      return matchPatterns(patterns, testString, stats);
    };
  }

  return matchPatterns(patterns, testString);
}

const unifyPaths = (paths_: Path | Path[]) => {
  const paths = arrify(paths_).flat();
  if (!paths.every((p) => typeof p === STRING_TYPE)) {
    throw new TypeError(`Non-string provided as watch path: ${paths}`);
  }
  return paths.map(normalizePathToUnix);
};

// If SLASH_SLASH occurs at the beginning of path, it is not replaced
//     because "//StoragePC/DrivePool/Movies" is a valid network path
const toUnix = (string: string) => {
  let str = string.replace(BACK_SLASH_RE, SLASH);
  let prepend = false;
  if (str.startsWith(SLASH_SLASH)) {
    prepend = true;
  }
  str = str.replace(DOUBLE_SLASH_RE, SLASH);
  if (prepend) {
    str = SLASH + str;
  }
  return str;
};

// Our version of upath.normalize
const normalizePathToUnix = (path: Path) => toUnix(sp.normalize(toUnix(path)));

const normalizeIgnored =
  () =>
  (path: Matcher): Matcher => {
    if (typeof path === "string") {
      return normalizePathToUnix(path);
    }
    return path;
  };

const EMPTY_SET = Object.freeze(new Set<string>());
/**
 * Directory entry.
 */
class DirEntry {
  path: Path;
  _removeWatcher: (dir: string, base: string) => void;
  items: Set<Path>;

  constructor(dir: Path, removeWatcher: (dir: string, base: string) => void) {
    this.path = dir;
    this._removeWatcher = removeWatcher;
    this.items = new Set<Path>();
  }

  add(item: string): void {
    const { items } = this;
    if (!items) return;
    if (item !== ONE_DOT && item !== TWO_DOTS) items.add(item);
  }

  async remove(item: string): Promise<void> {
    const { items } = this;
    if (!items) return;
    items.delete(item);
    if (items.size > 0) return;

    const dir = this.path;
    try {
      await readdir(dir);
    } catch {
      if (this._removeWatcher) {
        this._removeWatcher(sp.dirname(dir), sp.basename(dir));
      }
    }
  }

  has(item: string): boolean | undefined {
    const { items } = this;
    if (!items) return;
    return items.has(item);
  }

  getChildren(): string[] {
    const { items } = this;
    if (!items) return [];
    return [...items.values()];
  }

  dispose(): void {
    this.items.clear();
    this.path = "";
    this._removeWatcher = EMPTY_FN;
    this.items = EMPTY_SET;
    Object.freeze(this);
  }
}

const STAT_METHOD_F = "stat";
const STAT_METHOD_L = "lstat";
export class WatchHelper {
  fsw: FSWatcher;
  path: string;
  watchPath: string;
  followSymlinks: boolean;
  statMethod: "stat" | "lstat";

  constructor(path: string, follow: boolean, fsw: FSWatcher) {
    this.fsw = fsw;
    this.path = path = path.replace(REPLACER_RE, "");
    this.watchPath = path;
    this.followSymlinks = follow;
    this.statMethod = follow ? STAT_METHOD_F : STAT_METHOD_L;
  }

  entryPath(entry: EntryInfo): Path {
    return sp.join(this.watchPath, sp.relative(this.watchPath, entry.fullPath));
  }

  filterPath(entry: EntryInfo): boolean {
    const { stats } = entry;
    if (stats && stats.isSymbolicLink()) return this.filterDir(entry);
    const resolvedPath = this.entryPath(entry);
    return this.fsw._isntIgnored(resolvedPath, stats) && this.fsw._hasReadPermissions(stats!);
  }

  filterDir(entry: EntryInfo): boolean {
    return this.fsw._isntIgnored(this.entryPath(entry), entry.stats);
  }
}

/**
 * The result of `addAsync()`: the watcher plus a snapshot of what it now
 * watches, taken once the add work has fully settled.
 */
export type AddResult = {
  watcher: FSWatcher;
  requestedPaths: Path[];
  watched: Record<string, string[]>;
  watchedEntryCount: number;
};

const countWatchedEntries = (watched: Record<string, string[]>): number =>
  Object.keys(watched).length +
  Object.values(watched).reduce((total, children) => total + children.length, 0);

export interface FSWatcherEventMap {
  [EV.READY]: [];
  [EV.ERROR]: [error: Error];
  [EV.ALL]: [event: EventName, ...EmitArgs];
  [EV.ADD]: EmitArgs;
  [EV.CHANGE]: EmitArgs;
  [EV.ADD_DIR]: EmitArgs;
  [EV.UNLINK]: EmitArgs;
  [EV.UNLINK_DIR]: EmitArgs;
}

/**
 * Watches files & directories for changes. Emitted events:
 * `add`, `addDir`, `change`, `unlink`, `unlinkDir`, `all`, `error`
 *
 *     new FSWatcher()
 *       .add(directories)
 *       .on('add', path => log('File', path, 'was added'))
 */
export class FSWatcher extends EventEmitter<FSWatcherEventMap> {
  closed: boolean;
  options: FSWInstanceOptions;

  _closers: Map<string, Array<() => void | Promise<void>>>;
  _throttled: Map<ThrottleType, Map<Path, Throttler>>;
  _streams: Set<ReaddirpStream>;
  _symlinkPaths: Map<Path, string | boolean>;
  _watched: Map<string, DirEntry>;

  _pendingWrites: Map<string, PendingWrite>;
  _pendingUnlinks: Map<string, EmitArgsWithName>;
  _readyCount: number;
  _emitReady: () => void;
  _closePromise?: Promise<void>;
  _userIgnored?: MatchFunction;
  _readyEmitted: boolean;
  _boundRemove: (dir: string, item: string) => void;

  _nodeFsHandler: NodeFsHandler;

  // Not indenting methods for history sake; for now.
  constructor(_opts: ChokidarOptions = {}) {
    super();
    this.closed = false;

    this._closers = new Map();
    this._throttled = new Map();
    this._streams = new Set();
    this._symlinkPaths = new Map();
    this._watched = new Map();

    this._pendingWrites = new Map();
    this._pendingUnlinks = new Map();
    this._readyCount = 0;
    this._readyEmitted = false;

    const awf = _opts.awaitWriteFinish;
    const DEF_AWF = { stabilityThreshold: 2000, pollInterval: 100 };
    const opts: FSWInstanceOptions = {
      // Defaults
      persistent: true,
      ignoreInitial: false,
      interval: 100,
      followSymlinks: true,
      usePolling: false,
      atomic: true, // NOTE: overwritten later (depends on usePolling)
      ..._opts,
      // Change format
      ignored: _opts.ignored ? arrify(_opts.ignored) : arrify([]),
      awaitWriteFinish:
        awf === true ? DEF_AWF : typeof awf === "object" ? { ...DEF_AWF, ...awf } : false,
    };

    // Always default to polling on IBM i because fs.watch() is not available on IBM i.
    if (isIBMi) opts.usePolling = true;
    // Editor atomic write normalization enabled by default with fs.watch
    if (opts.atomic === undefined) opts.atomic = !opts.usePolling;
    // opts.atomic = typeof _opts.atomic === 'number' ? _opts.atomic : 100;
    // Global override. Useful for developers, who need to force polling for all
    // instances of chokidar, regardless of usage / dependency depth
    const envPoll = process.env.CHOKIDAR_USEPOLLING;
    if (envPoll !== undefined) {
      const envLower = envPoll.toLowerCase();
      if (envLower === "false" || envLower === "0") opts.usePolling = false;
      else if (envLower === "true" || envLower === "1") opts.usePolling = true;
      else opts.usePolling = !!envLower;
    }
    const envInterval = process.env.CHOKIDAR_INTERVAL;
    if (envInterval) opts.interval = Number.parseInt(envInterval, 10);
    // This is done to emit ready only once, but each 'add' will increase that?
    let readyCalls = 0;
    this._emitReady = () => {
      readyCalls++;
      if (readyCalls >= this._readyCount) {
        this._emitReady = EMPTY_FN;
        this._readyEmitted = true;
        // use process.nextTick to allow time for listener to be bound
        process.nextTick(() => this.emit(EV.READY));
      }
    };

    this._boundRemove = this._remove.bind(this);

    this.options = opts;
    this._nodeFsHandler = new NodeFsHandler(this);
    // You're frozen when your heart's not open.
    Object.freeze(opts);
  }

  // Public methods

  /**
   * Adds paths to be watched on an existing FSWatcher instance.
   * @param paths_ file or file list. Other arguments are unused
   */
  add(paths_: Path | Path[], _origAdd?: string, _internal?: boolean): FSWatcher {
    void this._addInternal(paths_, _origAdd, _internal);
    return this;
  }

  /**
   * Like `add()`, but resolves only after the same internal path-add work that
   * `add()` runs in the background has fully settled (including the recursive
   * parent re-add chokidar chains after the first batch). Resolves with a
   * snapshot of the watched map so callers can inspect real watched state
   * immediately instead of racing the `ready` event. Add-time errors still flow
   * through the `error` event, exactly as with `add()`.
   */
  async addAsync(paths_: Path | Path[]): Promise<AddResult> {
    const requestedPaths = unifyPaths(paths_);
    await this._addInternal(paths_);
    const watched = this.getWatched();
    return {
      watcher: this,
      requestedPaths,
      watched,
      watchedEntryCount: countWatchedEntries(watched),
    };
  }

  /**
   * Resolves after the initial-scan `ready` event. Resolves immediately if
   * `ready` already fired. Replaces ad-hoc `new Promise(r => once("ready", r))`.
   */
  whenReady(): Promise<this> {
    if (this._readyEmitted) return Promise.resolve(this);
    return new Promise((resolve) => {
      this.once(EV.READY, () => resolve(this));
    });
  }

  /**
   * The shared body of `add()`/`addAsync()`. Returns the promise for the full
   * add operation; `add()` drops it (preserving its synchronous return type)
   * while `addAsync()` awaits it.
   */
  private _addInternal(
    paths_: Path | Path[],
    _origAdd?: string,
    _internal?: boolean,
  ): Promise<void> {
    this.closed = false;
    this._closePromise = undefined;
    const paths = unifyPaths(paths_);

    if (!this._readyCount) this._readyCount = 0;
    this._readyCount += paths.length;
    return Promise.all(
      paths.map(async (path) => {
        const res = await this._nodeFsHandler._addToNodeFs(
          path,
          !_internal,
          undefined,
          0,
          _origAdd,
        );
        if (res) this._emitReady();
        return res;
      }),
    ).then((results) => {
      if (this.closed) return;
      return Promise.all(
        results.map((item) =>
          item ? this._addInternal(sp.dirname(item), sp.basename(_origAdd || item)) : undefined,
        ),
      ).then(() => undefined);
    });
  }

  /**
   * Close watchers and remove all listeners from watched paths.
   */
  close(): Promise<void> {
    if (this._closePromise) {
      return this._closePromise;
    }
    this.closed = true;

    // Memory management.
    this.removeAllListeners();
    const closers: Array<Promise<void>> = [];
    this._closers.forEach((closerList) =>
      closerList.forEach((closer) => {
        const promise = closer();
        if (promise instanceof Promise) closers.push(promise);
      }),
    );
    this._streams.forEach((stream) => stream.destroy());
    this._userIgnored = undefined;
    this._readyCount = 0;
    this._readyEmitted = false;
    this._watched.forEach((dirent) => dirent.dispose());

    this._closers.clear();
    this._watched.clear();
    this._streams.clear();
    this._symlinkPaths.clear();
    this._throttled.clear();

    this._closePromise = closers.length
      ? Promise.all(closers).then(() => undefined)
      : Promise.resolve();
    return this._closePromise;
  }

  /**
   * Expose list of watched paths
   */
  getWatched(): Record<string, string[]> {
    const watchList: Record<string, string[]> = {};
    this._watched.forEach((entry, dir) => {
      const index = dir || ONE_DOT;
      watchList[index] = entry.getChildren().sort();
    });
    return watchList;
  }

  emitWithAll(event: EventName, args: EmitArgs): void {
    this.emit(event, ...args);
    if (event !== EV.ERROR) this.emit(EV.ALL, event, ...args);
  }

  // Common helpers
  // --------------

  /**
   * Normalize and emit events.
   * Calling _emit DOES NOT MEAN emit() would be called!
   * @returns the error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  async _emit(event: EventName, path: Path, stats?: Stats): Promise<this | undefined> {
    if (this.closed) return;

    const opts = this.options;
    if (isWindows) path = sp.normalize(path);
    const args: EmitArgs = [path];
    if (stats != null) args.push(stats);

    const awf = opts.awaitWriteFinish;
    let pw: PendingWrite | undefined;
    if (awf && (pw = this._pendingWrites.get(path))) {
      pw.lastChange = Date.now();
      return this;
    }

    if (opts.atomic) {
      if (event === EV.UNLINK) {
        this._pendingUnlinks.set(path, [event, ...args]);
        setTimeout(
          () => {
            this._pendingUnlinks.forEach((entry: EmitArgsWithName, path: Path) => {
              this.emit(...entry);
              this.emit(EV.ALL, ...entry);
              this._pendingUnlinks.delete(path);
            });
          },
          typeof opts.atomic === "number" ? opts.atomic : 100,
        );
        return this;
      }
      if (event === EV.ADD && this._pendingUnlinks.has(path)) {
        event = EV.CHANGE;
        this._pendingUnlinks.delete(path);
      }
    }

    if (awf && (event === EV.ADD || event === EV.CHANGE) && this._readyEmitted) {
      const awfEmit = (err?: Error, stats?: Stats) => {
        if (err) {
          event = EV.ERROR;
          this.emitWithAll(event, [err as unknown as Path]);
        } else if (stats) {
          // if stats doesn't exist the file must have been deleted
          if (args.length > 1) {
            args[1] = stats;
          } else {
            args.push(stats);
          }
          this.emitWithAll(event, args);
        }
      };

      this._awaitWriteFinish(path, awf.stabilityThreshold, event, awfEmit);
      return this;
    }

    if (event === EV.CHANGE) {
      const isThrottled = !this._throttle(EV.CHANGE, path, 50);
      if (isThrottled) return this;
    }

    this.emitWithAll(event, args);

    return this;
  }

  /**
   * Common handler for errors
   * @returns The error if defined, otherwise the value of the FSWatcher instance's `closed` flag
   */
  _handleError(error: Error): Error | boolean {
    const code = error && (error as Error & { code: string }).code;
    if (error && code !== "ENOENT" && code !== "ENOTDIR") {
      this.emit(EV.ERROR, error);
    }
    return error || this.closed;
  }

  /**
   * Helper utility for throttling
   * @returns tracking object or false if action should be suppressed
   */
  _throttle(actionType: ThrottleType, path: Path, timeout: number): Throttler | false {
    if (!this._throttled.has(actionType)) {
      this._throttled.set(actionType, new Map());
    }

    const action = this._throttled.get(actionType);
    if (!action) throw new Error("invalid throttle");
    const actionPath = action.get(path);

    if (actionPath) {
      actionPath.count++;
      return false;
    }

    let timeoutObject: NodeJS.Timeout;
    const clear = () => {
      const item = action.get(path);
      const count = item ? item.count : 0;
      action.delete(path);
      clearTimeout(timeoutObject);
      if (item) clearTimeout(item.timeoutObject);
      return count;
    };
    timeoutObject = setTimeout(clear, timeout);
    const thr = { timeoutObject, clear, count: 0 };
    action.set(path, thr);
    return thr;
  }

  _incrReadyCount(): number {
    return this._readyCount++;
  }

  /**
   * Awaits write operation to finish.
   * Polls a newly created file for size variations. When files size does not change for 'threshold' milliseconds calls callback.
   */
  _awaitWriteFinish(
    path: Path,
    threshold: number,
    event: EventName,
    awfEmit: (err?: Error, stat?: Stats) => void,
  ): void {
    const awf = this.options.awaitWriteFinish;
    if (typeof awf !== "object") return;
    const pollInterval = awf.pollInterval as unknown as number;
    let timeoutHandler: NodeJS.Timeout;

    const fullPath = path;
    const now = Date.now();

    const writes = this._pendingWrites;
    function awaitWriteFinishFn(prevStat?: Stats): void {
      statcb(fullPath, (err, curStat) => {
        if (err || !writes.has(path)) {
          if (err && (err as NodeJS.ErrnoException).code !== "ENOENT") awfEmit(err);
          return;
        }

        const now = Date.now();

        if (prevStat && curStat.size !== prevStat.size) {
          writes.get(path)!.lastChange = now;
        }
        const pw = writes.get(path)!;
        const df = now - pw.lastChange;

        if (df >= threshold) {
          writes.delete(path);
          awfEmit(undefined, curStat);
        } else {
          timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval, curStat);
        }
      });
    }

    if (!writes.has(path)) {
      writes.set(path, {
        lastChange: now,
        cancelWait: () => {
          writes.delete(path);
          clearTimeout(timeoutHandler);
          return event;
        },
      });
      timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval);
    }
  }

  /**
   * Determines whether user has asked to ignore this path.
   */
  _isIgnored(path: Path, stats?: Stats): boolean {
    if (this.options.atomic && DOT_RE.test(path)) return true;
    if (!this._userIgnored) {
      const ign = this.options.ignored;
      const ignored = (ign || []).map(normalizeIgnored());
      this._userIgnored = anymatch(ignored, undefined);
    }

    return this._userIgnored(path, stats);
  }

  _isntIgnored(path: Path, stat?: Stats): boolean {
    return !this._isIgnored(path, stat);
  }

  /**
   * Provides a set of common helpers and properties relating to symlink handling.
   */
  _getWatchHelpers(path: Path): WatchHelper {
    return new WatchHelper(path, this.options.followSymlinks, this);
  }

  // Directory helpers
  // -----------------

  /**
   * Provides directory tracking objects
   */
  _getWatchedDir(directory: string): DirEntry {
    const dir = sp.resolve(directory);
    if (!this._watched.has(dir)) this._watched.set(dir, new DirEntry(dir, this._boundRemove));
    return this._watched.get(dir)!;
  }

  // File helpers
  // ------------

  /**
   * Check for read permissions: https://stackoverflow.com/a/11781404/1358405
   */
  _hasReadPermissions(stats: Stats): boolean {
    return Boolean(Number(stats.mode) & 0o400);
  }

  /**
   * Handles emitting unlink events for
   * files and directories, and via recursion, for
   * files and directories within directories that are unlinked
   */
  _remove(directory: string, item: string, isDirectory?: boolean): void {
    // if what is being deleted is a directory, get that directory's paths
    // for recursive deleting and cleaning of watched object
    // if it is not a directory, nestedDirectoryChildren will be empty array
    const path = sp.join(directory, item);
    const fullPath = sp.resolve(path);
    isDirectory =
      isDirectory != null ? isDirectory : this._watched.has(path) || this._watched.has(fullPath);

    // prevent duplicate handling in case of arriving here nearly simultaneously
    // via multiple paths (such as _handleFile and _handleDir)
    if (!this._throttle("remove", path, 100)) return;

    // if the only watched file is removed, watch for its return
    if (!isDirectory && this._watched.size === 1) {
      this.add(directory, item, true);
    }

    // This will create a new entry in the watched object in either case
    // so we got to do the directory check beforehand
    const wp = this._getWatchedDir(path);
    const nestedDirectoryChildren = wp.getChildren();

    // Recursively remove children directories / files.
    nestedDirectoryChildren.forEach((nested) => this._remove(path, nested));

    // Check if item was on the watched list and remove it
    const parent = this._getWatchedDir(directory);
    const wasTracked = parent.has(item);
    parent.remove(item);

    // Fixes issue #1042 -> Relative paths were detected and added as symlinks,
    // but never removed from the map in case the path was deleted.
    if (this._symlinkPaths.has(fullPath)) {
      this._symlinkPaths.delete(fullPath);
    }

    // If we wait for this file to be fully written, cancel the wait.
    const relPath = path;
    if (this.options.awaitWriteFinish && this._pendingWrites.has(relPath)) {
      const event = this._pendingWrites.get(relPath)!.cancelWait();
      if (event === EV.ADD) return;
    }

    // The Entry will either be a directory that just got removed
    // or a bogus entry to a file, in either case we have to remove it
    this._watched.delete(path);
    this._watched.delete(fullPath);
    const eventName: EventName = isDirectory ? EV.UNLINK_DIR : EV.UNLINK;
    if (wasTracked && !this._isIgnored(path)) this._emit(eventName, path);

    // Avoid conflicts if we later create another file with the same name
    this._closePath(path);
  }

  /**
   * Closes all watchers for a path
   */
  _closePath(path: Path): void {
    this._closeFile(path);
    const dir = sp.dirname(path);
    this._getWatchedDir(dir).remove(sp.basename(path));
  }

  /**
   * Closes only file-specific watchers
   */
  _closeFile(path: Path): void {
    const closers = this._closers.get(path);
    if (!closers) return;
    closers.forEach((closer) => closer());
    this._closers.delete(path);
  }

  _addPathCloser(path: Path, closer: () => void): void {
    if (!closer) return;
    let list = this._closers.get(path);
    if (!list) {
      list = [];
      this._closers.set(path, list);
    }
    list.push(closer);
  }

  _readdirp(root: Path, opts?: Partial<ReaddirpOptions>): ReaddirpStream | undefined {
    if (this.closed) return;
    const options = { type: EV.ALL, lstat: true, ...opts, depth: 0 };
    let stream: ReaddirpStream | undefined = new ReaddirpStream(root, options);
    this._streams.add(stream);
    stream.once(STR_CLOSE, () => {
      stream = undefined;
    });
    stream.once(STR_END, () => {
      if (stream) {
        this._streams.delete(stream);
        stream = undefined;
      }
    });
    return stream;
  }
}

/**
 * Instantiates watcher with paths to be tracked.
 * @returns an instance of FSWatcher for chaining.
 * @example
 * const watcher = watch('.').on('all', (event, path) => { console.log(event, path); });
 */
export function watch(paths: string | string[], options: ChokidarOptions = {}): FSWatcher {
  const watcher = new FSWatcher(options);
  watcher.add(paths);
  return watcher;
}

/**
 * Async `watch()`: creates a watcher and resolves once `addAsync()` settles, so
 * callers can inspect real watched state immediately after creation.
 */
export async function watchAsync(
  paths: string | string[],
  options: ChokidarOptions = {},
): Promise<FSWatcher> {
  const watcher = new FSWatcher(options);
  await watcher.addAsync(paths);
  return watcher;
}

export default {
  watch: watch as typeof watch,
  watchAsync: watchAsync as typeof watchAsync,
  FSWatcher: FSWatcher as typeof FSWatcher,
};
