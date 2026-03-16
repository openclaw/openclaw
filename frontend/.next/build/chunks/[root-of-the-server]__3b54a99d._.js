module.exports = [
"[turbopack-node]/globals.ts [postcss] (ecmascript)", ((__turbopack_context__, module, exports) => {

// @ts-ignore
process.turbopack = {};
}),
"[externals]/node:net [external] (node:net, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:net", () => require("node:net"));

module.exports = mod;
}),
"[externals]/node:stream [external] (node:stream, cjs)", ((__turbopack_context__, module, exports) => {

const mod = __turbopack_context__.x("node:stream", () => require("node:stream"));

module.exports = mod;
}),
"[turbopack-node]/compiled/stacktrace-parser/index.js [postcss] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "parse",
    ()=>parse
]);
if (typeof __nccwpck_require__ !== "undefined") __nccwpck_require__.ab = ("TURBOPACK compile-time value", "/ROOT/compiled/stacktrace-parser") + "/";
var n = "<unknown>";
function parse(e) {
    var r = e.split("\n");
    return r.reduce(function(e, r) {
        var n = parseChrome(r) || parseWinjs(r) || parseGecko(r) || parseNode(r) || parseJSC(r);
        if (n) {
            e.push(n);
        }
        return e;
    }, []);
}
var a = /^\s*at (.*?) ?\(((?:file|https?|blob|chrome-extension|native|eval|webpack|<anonymous>|\/|[a-z]:\\|\\\\).*?)(?::(\d+))?(?::(\d+))?\)?\s*$/i;
var l = /\((\S*)(?::(\d+))(?::(\d+))\)/;
function parseChrome(e) {
    var r = a.exec(e);
    if (!r) {
        return null;
    }
    var u = r[2] && r[2].indexOf("native") === 0;
    var t = r[2] && r[2].indexOf("eval") === 0;
    var i = l.exec(r[2]);
    if (t && i != null) {
        r[2] = i[1];
        r[3] = i[2];
        r[4] = i[3];
    }
    return {
        file: !u ? r[2] : null,
        methodName: r[1] || n,
        arguments: u ? [
            r[2]
        ] : [],
        lineNumber: r[3] ? +r[3] : null,
        column: r[4] ? +r[4] : null
    };
}
var u = /^\s*at (?:((?:\[object object\])?.+) )?\(?((?:file|ms-appx|https?|webpack|blob):.*?):(\d+)(?::(\d+))?\)?\s*$/i;
function parseWinjs(e) {
    var r = u.exec(e);
    if (!r) {
        return null;
    }
    return {
        file: r[2],
        methodName: r[1] || n,
        arguments: [],
        lineNumber: +r[3],
        column: r[4] ? +r[4] : null
    };
}
var t = /^\s*(.*?)(?:\((.*?)\))?(?:^|@)((?:file|https?|blob|chrome|webpack|resource|\[native).*?|[^@]*bundle)(?::(\d+))?(?::(\d+))?\s*$/i;
var i = /(\S+) line (\d+)(?: > eval line \d+)* > eval/i;
function parseGecko(e) {
    var r = t.exec(e);
    if (!r) {
        return null;
    }
    var a = r[3] && r[3].indexOf(" > eval") > -1;
    var l = i.exec(r[3]);
    if (a && l != null) {
        r[3] = l[1];
        r[4] = l[2];
        r[5] = null;
    }
    return {
        file: r[3],
        methodName: r[1] || n,
        arguments: r[2] ? r[2].split(",") : [],
        lineNumber: r[4] ? +r[4] : null,
        column: r[5] ? +r[5] : null
    };
}
var s = /^\s*(?:([^@]*)(?:\((.*?)\))?@)?(\S.*?):(\d+)(?::(\d+))?\s*$/i;
function parseJSC(e) {
    var r = s.exec(e);
    if (!r) {
        return null;
    }
    return {
        file: r[3],
        methodName: r[1] || n,
        arguments: [],
        lineNumber: +r[4],
        column: r[5] ? +r[5] : null
    };
}
var o = /^\s*at (?:((?:\[object object\])?[^\\/]+(?: \[as \S+\])?) )?\(?(.*?):(\d+)(?::(\d+))?\)?\s*$/i;
function parseNode(e) {
    var r = o.exec(e);
    if (!r) {
        return null;
    }
    return {
        file: r[2],
        methodName: r[1] || n,
        arguments: [],
        lineNumber: +r[3],
        column: r[4] ? +r[4] : null
    };
}
}),
"[turbopack-node]/ipc/error.ts [postcss] (ecmascript)", ((__turbopack_context__) => {
"use strict";

// merged from next.js
// https://github.com/vercel/next.js/blob/e657741b9908cf0044aaef959c0c4defb19ed6d8/packages/next/src/lib/is-error.ts
// https://github.com/vercel/next.js/blob/e657741b9908cf0044aaef959c0c4defb19ed6d8/packages/next/src/shared/lib/is-plain-object.ts
__turbopack_context__.s([
    "default",
    ()=>isError,
    "getProperError",
    ()=>getProperError
]);
function isError(err) {
    return typeof err === 'object' && err !== null && 'name' in err && 'message' in err;
}
function getProperError(err) {
    if (isError(err)) {
        return err;
    }
    if ("TURBOPACK compile-time falsy", 0) //TURBOPACK unreachable
    ;
    return new Error(isPlainObject(err) ? JSON.stringify(err) : err + '');
}
function getObjectClassLabel(value) {
    return Object.prototype.toString.call(value);
}
function isPlainObject(value) {
    if (getObjectClassLabel(value) !== '[object Object]') {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    /**
   * this used to be previously:
   *
   * `return prototype === null || prototype === Object.prototype`
   *
   * but Edge Runtime expose Object from vm, being that kind of type-checking wrongly fail.
   *
   * It was changed to the current implementation since it's resilient to serialization.
   */ return prototype === null || prototype.hasOwnProperty('isPrototypeOf');
}
}),
"[turbopack-node]/ipc/index.ts [postcss] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "IPC",
    ()=>IPC,
    "structuredError",
    ()=>structuredError
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$net__$5b$external$5d$__$28$node$3a$net$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:net [external] (node:net, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$stream__$5b$external$5d$__$28$node$3a$stream$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/node:stream [external] (node:stream, cjs)");
var __TURBOPACK__imported__module__$5b$turbopack$2d$node$5d2f$compiled$2f$stacktrace$2d$parser$2f$index$2e$js__$5b$postcss$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[turbopack-node]/compiled/stacktrace-parser/index.js [postcss] (ecmascript)");
var __TURBOPACK__imported__module__$5b$turbopack$2d$node$5d2f$ipc$2f$error$2e$ts__$5b$postcss$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[turbopack-node]/ipc/error.ts [postcss] (ecmascript)");
;
;
;
;
function structuredError(e) {
    e = (0, __TURBOPACK__imported__module__$5b$turbopack$2d$node$5d2f$ipc$2f$error$2e$ts__$5b$postcss$5d$__$28$ecmascript$29$__["getProperError"])(e);
    return {
        name: e.name,
        message: e.message,
        stack: typeof e.stack === 'string' ? (0, __TURBOPACK__imported__module__$5b$turbopack$2d$node$5d2f$compiled$2f$stacktrace$2d$parser$2f$index$2e$js__$5b$postcss$5d$__$28$ecmascript$29$__["parse"])(e.stack) : [],
        cause: e.cause ? structuredError((0, __TURBOPACK__imported__module__$5b$turbopack$2d$node$5d2f$ipc$2f$error$2e$ts__$5b$postcss$5d$__$28$ecmascript$29$__["getProperError"])(e.cause)) : undefined
    };
}
function createIpc(port) {
    const socket = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$net__$5b$external$5d$__$28$node$3a$net$2c$__cjs$29$__["createConnection"])({
        port,
        host: '127.0.0.1'
    });
    /**
   * A writable stream that writes to the socket.
   * We don't write directly to the socket because we need to
   * handle backpressure and wait for the socket to be drained
   * before writing more data.
   */ const socketWritable = new __TURBOPACK__imported__module__$5b$externals$5d2f$node$3a$stream__$5b$external$5d$__$28$node$3a$stream$2c$__cjs$29$__["Writable"]({
        write (chunk, _enc, cb) {
            if (socket.write(chunk)) {
                cb();
            } else {
                socket.once('drain', cb);
            }
        },
        final (cb) {
            socket.end(cb);
        }
    });
    const packetQueue = [];
    const recvPromiseResolveQueue = [];
    function pushPacket(packet) {
        const recvPromiseResolve = recvPromiseResolveQueue.shift();
        if (recvPromiseResolve != null) {
            recvPromiseResolve(JSON.parse(packet.toString('utf8')));
        } else {
            packetQueue.push(packet);
        }
    }
    let state = {
        type: 'waiting'
    };
    let buffer = Buffer.alloc(0);
    socket.once('connect', ()=>{
        socket.setNoDelay(true);
        socket.on('data', (chunk)=>{
            buffer = Buffer.concat([
                buffer,
                chunk
            ]);
            loop: while(true){
                switch(state.type){
                    case 'waiting':
                        {
                            if (buffer.length >= 4) {
                                const length = buffer.readUInt32BE(0);
                                buffer = buffer.subarray(4);
                                state = {
                                    type: 'packet',
                                    length
                                };
                            } else {
                                break loop;
                            }
                            break;
                        }
                    case 'packet':
                        {
                            if (buffer.length >= state.length) {
                                const packet = buffer.subarray(0, state.length);
                                buffer = buffer.subarray(state.length);
                                state = {
                                    type: 'waiting'
                                };
                                pushPacket(packet);
                            } else {
                                break loop;
                            }
                            break;
                        }
                    default:
                        invariant(state, (state)=>`Unknown state type: ${state?.type}`);
                }
            }
        });
    });
    // When the socket is closed, this process is no longer needed.
    // This might happen e. g. when parent process is killed or
    // node.js pool is garbage collected.
    socket.once('close', ()=>{
        process.exit(0);
    });
    // TODO(lukesandberg): some of the messages being sent are very large and contain lots
    //  of redundant information.  Consider adding gzip compression to our stream.
    function doSend(message) {
        return new Promise((resolve, reject)=>{
            // Reserve 4 bytes for our length prefix, we will over-write after encoding.
            const packet = Buffer.from('0000' + message, 'utf8');
            packet.writeUInt32BE(packet.length - 4, 0);
            socketWritable.write(packet, (err)=>{
                process.stderr.write(`TURBOPACK_OUTPUT_D\n`);
                process.stdout.write(`TURBOPACK_OUTPUT_D\n`);
                if (err != null) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
    function send(message) {
        return doSend(JSON.stringify(message));
    }
    function sendReady() {
        return doSend('');
    }
    return {
        async recv () {
            const packet = packetQueue.shift();
            if (packet != null) {
                return JSON.parse(packet.toString('utf8'));
            }
            const result = await new Promise((resolve)=>{
                recvPromiseResolveQueue.push((result)=>{
                    resolve(result);
                });
            });
            return result;
        },
        send (message) {
            return send(message);
        },
        sendReady,
        async sendError (error) {
            let failed = false;
            try {
                await send({
                    type: 'error',
                    ...structuredError(error)
                });
            } catch (err) {
                // There's nothing we can do about errors that happen after this point, we can't tell anyone
                // about them.
                console.error('failed to send error back to rust:', err);
                failed = true;
            }
            await new Promise((res)=>socket.end(()=>res()));
            process.exit(failed ? 1 : 0);
        }
    };
}
const PORT = process.argv[2];
const IPC = createIpc(parseInt(PORT, 10));
process.on('uncaughtException', (err)=>{
    IPC.sendError(err);
});
const improveConsole = (name, stream, addStack)=>{
    // @ts-ignore
    const original = console[name];
    // @ts-ignore
    const stdio = process[stream];
    // @ts-ignore
    console[name] = (...args)=>{
        stdio.write(`TURBOPACK_OUTPUT_B\n`);
        original(...args);
        if (addStack) {
            const stack = new Error().stack?.replace(/^.+\n.+\n/, '') + '\n';
            stdio.write('TURBOPACK_OUTPUT_S\n');
            stdio.write(stack);
        }
        stdio.write('TURBOPACK_OUTPUT_E\n');
    };
};
improveConsole('error', 'stderr', true);
improveConsole('warn', 'stderr', true);
improveConsole('count', 'stdout', true);
improveConsole('trace', 'stderr', false);
improveConsole('log', 'stdout', true);
improveConsole('group', 'stdout', true);
improveConsole('groupCollapsed', 'stdout', true);
improveConsole('table', 'stdout', true);
improveConsole('debug', 'stdout', true);
improveConsole('info', 'stdout', true);
improveConsole('dir', 'stdout', true);
improveConsole('dirxml', 'stdout', true);
improveConsole('timeEnd', 'stdout', true);
improveConsole('timeLog', 'stdout', true);
improveConsole('timeStamp', 'stdout', true);
improveConsole('assert', 'stderr', true);
/**
 * Utility function to ensure all variants of an enum are handled.
 */ function invariant(never, computeMessage) {
    throw new Error(`Invariant: ${computeMessage(never)}`);
}
}),
"[turbopack-node]/ipc/evaluate.ts [postcss] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "run",
    ()=>run
]);
var __TURBOPACK__imported__module__$5b$turbopack$2d$node$5d2f$ipc$2f$index$2e$ts__$5b$postcss$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[turbopack-node]/ipc/index.ts [postcss] (ecmascript)");
;
const ipc = __TURBOPACK__imported__module__$5b$turbopack$2d$node$5d2f$ipc$2f$index$2e$ts__$5b$postcss$5d$__$28$ecmascript$29$__["IPC"];
const queue = [];
const run = async (moduleFactory)=>{
    let nextId = 1;
    const requests = new Map();
    const internalIpc = {
        sendInfo: (message)=>ipc.send({
                type: 'info',
                data: message
            }),
        sendRequest: (message)=>{
            const id = nextId++;
            let resolve, reject;
            const promise = new Promise((res, rej)=>{
                resolve = res;
                reject = rej;
            });
            requests.set(id, {
                resolve,
                reject
            });
            return ipc.send({
                type: 'request',
                id,
                data: message
            }).then(()=>promise);
        },
        sendError: (error)=>{
            return ipc.sendError(error);
        }
    };
    // Initialize module and send ready message
    let getValue;
    try {
        const module = await moduleFactory();
        if (typeof module.init === 'function') {
            await module.init();
        }
        getValue = module.default;
        await ipc.sendReady();
    } catch (err) {
        await ipc.sendReady();
        await ipc.sendError(err);
    }
    // Queue handling
    let isRunning = false;
    const run = async ()=>{
        while(queue.length > 0){
            const args = queue.shift();
            try {
                const value = await getValue(internalIpc, ...args);
                await ipc.send({
                    type: 'end',
                    data: value === undefined ? undefined : JSON.stringify(value, null, 2),
                    duration: 0
                });
            } catch (e) {
                await ipc.sendError(e);
            }
        }
        isRunning = false;
    };
    // Communication handling
    while(true){
        const msg = await ipc.recv();
        switch(msg.type){
            case 'evaluate':
                {
                    queue.push(msg.args);
                    if (!isRunning) {
                        isRunning = true;
                        run();
                    }
                    break;
                }
            case 'result':
                {
                    const request = requests.get(msg.id);
                    if (request) {
                        requests.delete(msg.id);
                        if (msg.error) {
                            request.reject(new Error(msg.error));
                        } else {
                            request.resolve(msg.data);
                        }
                    }
                    break;
                }
            default:
                {
                    console.error('unexpected message type', msg.type);
                    process.exit(1);
                }
        }
    }
};
}),
"[turbopack-node]/ipc/evaluate.ts/evaluate.js { INNER => \"[turbopack-node]/transforms/postcss.ts { CONFIG => \\\"[project]/frontend/postcss.config.mjs [postcss] (ecmascript)\\\" } [postcss] (ecmascript)\", RUNTIME => \"[turbopack-node]/ipc/evaluate.ts [postcss] (ecmascript)\" } [postcss] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([]);
var __TURBOPACK__imported__module__$5b$turbopack$2d$node$5d2f$ipc$2f$evaluate$2e$ts__$5b$postcss$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[turbopack-node]/ipc/evaluate.ts [postcss] (ecmascript)");
;
(0, __TURBOPACK__imported__module__$5b$turbopack$2d$node$5d2f$ipc$2f$evaluate$2e$ts__$5b$postcss$5d$__$28$ecmascript$29$__["run"])(()=>__turbopack_context__.A('[turbopack-node]/transforms/postcss.ts { CONFIG => "[project]/frontend/postcss.config.mjs [postcss] (ecmascript)" } [postcss] (ecmascript, async loader)'));
}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__3b54a99d._.js.map