"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.playAudio = playAudio;
exports.recordAudio = recordAudio;
const node_child_process_1 = require("node:child_process");
const node_stream_1 = require("node:stream");
const node_process_1 = require("node:process");
const uploads_1 = require("../internal/uploads.js");
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_CHANNELS = 1;
const isNode = Boolean(node_process_1.versions?.node);
const recordingProviders = {
    win32: 'dshow',
    darwin: 'avfoundation',
    linux: 'alsa',
    aix: 'alsa',
    android: 'alsa',
    freebsd: 'alsa',
    haiku: 'alsa',
    sunos: 'alsa',
    netbsd: 'alsa',
    openbsd: 'alsa',
    cygwin: 'dshow',
};
function isResponse(stream) {
    return typeof stream.body !== 'undefined';
}
function isFile(stream) {
    (0, uploads_1.checkFileSupport)();
    return stream instanceof File;
}
async function nodejsPlayAudio(stream) {
    return new Promise((resolve, reject) => {
        try {
            const ffplay = (0, node_child_process_1.spawn)('ffplay', ['-autoexit', '-nodisp', '-i', 'pipe:0']);
            if (isResponse(stream)) {
                stream.body.pipe(ffplay.stdin);
            }
            else if (isFile(stream)) {
                node_stream_1.Readable.from(stream.stream()).pipe(ffplay.stdin);
            }
            else {
                stream.pipe(ffplay.stdin);
            }
            ffplay.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`ffplay process exited with code ${code}`));
                }
                resolve();
            });
        }
        catch (error) {
            reject(error);
        }
    });
}
async function playAudio(input) {
    if (isNode) {
        return nodejsPlayAudio(input);
    }
    throw new Error('Play audio is not supported in the browser yet. Check out https://npm.im/wavtools as an alternative.');
}
function nodejsRecordAudio({ signal, device, timeout } = {}) {
    (0, uploads_1.checkFileSupport)();
    return new Promise((resolve, reject) => {
        const data = [];
        const provider = recordingProviders[node_process_1.platform];
        try {
            const ffmpeg = (0, node_child_process_1.spawn)('ffmpeg', [
                '-f',
                provider,
                '-i',
                `:${device ?? 0}`, // default audio input device; adjust as needed
                '-ar',
                DEFAULT_SAMPLE_RATE.toString(),
                '-ac',
                DEFAULT_CHANNELS.toString(),
                '-f',
                'wav',
                'pipe:1',
            ], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            ffmpeg.stdout.on('data', (chunk) => {
                data.push(chunk);
            });
            ffmpeg.on('error', (error) => {
                console.error(error);
                reject(error);
            });
            ffmpeg.on('close', (code) => {
                returnData();
            });
            function returnData() {
                const audioBuffer = Buffer.concat(data);
                const audioFile = new File([audioBuffer], 'audio.wav', { type: 'audio/wav' });
                resolve(audioFile);
            }
            if (typeof timeout === 'number' && timeout > 0) {
                const internalSignal = AbortSignal.timeout(timeout);
                internalSignal.addEventListener('abort', () => {
                    ffmpeg.kill('SIGTERM');
                });
            }
            if (signal) {
                signal.addEventListener('abort', () => {
                    ffmpeg.kill('SIGTERM');
                });
            }
        }
        catch (error) {
            reject(error);
        }
    });
}
async function recordAudio(options = {}) {
    if (isNode) {
        return nodejsRecordAudio(options);
    }
    throw new Error('Record audio is not supported in the browser. Check out https://npm.im/wavtools as an alternative.');
}
//# sourceMappingURL=audio.js.map