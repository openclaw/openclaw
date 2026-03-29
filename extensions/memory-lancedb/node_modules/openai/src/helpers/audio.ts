import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { platform, versions } from 'node:process';
import { checkFileSupport } from '../internal/uploads';

const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_CHANNELS = 1;

const isNode = Boolean(versions?.node);

const recordingProviders: Record<NodeJS.Platform, string> = {
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

function isResponse(stream: NodeJS.ReadableStream | Response | File): stream is Response {
  return typeof (stream as any).body !== 'undefined';
}

function isFile(stream: NodeJS.ReadableStream | Response | File): stream is File {
  checkFileSupport();
  return stream instanceof File;
}

async function nodejsPlayAudio(stream: NodeJS.ReadableStream | Response | File): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const ffplay = spawn('ffplay', ['-autoexit', '-nodisp', '-i', 'pipe:0']);

      if (isResponse(stream)) {
        (stream.body! as any).pipe(ffplay.stdin);
      } else if (isFile(stream)) {
        Readable.from(stream.stream()).pipe(ffplay.stdin);
      } else {
        stream.pipe(ffplay.stdin);
      }

      ffplay.on('close', (code: number) => {
        if (code !== 0) {
          reject(new Error(`ffplay process exited with code ${code}`));
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function playAudio(input: NodeJS.ReadableStream | Response | File): Promise<void> {
  if (isNode) {
    return nodejsPlayAudio(input);
  }

  throw new Error(
    'Play audio is not supported in the browser yet. Check out https://npm.im/wavtools as an alternative.',
  );
}

type RecordAudioOptions = {
  signal?: AbortSignal;
  device?: number;
  timeout?: number;
};

function nodejsRecordAudio({ signal, device, timeout }: RecordAudioOptions = {}): Promise<File> {
  checkFileSupport();
  return new Promise((resolve, reject) => {
    const data: any[] = [];
    const provider = recordingProviders[platform];
    try {
      const ffmpeg = spawn(
        'ffmpeg',
        [
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
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

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
    } catch (error) {
      reject(error);
    }
  });
}

export async function recordAudio(options: RecordAudioOptions = {}) {
  if (isNode) {
    return nodejsRecordAudio(options);
  }

  throw new Error(
    'Record audio is not supported in the browser. Check out https://npm.im/wavtools as an alternative.',
  );
}
