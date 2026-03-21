/// <reference types="node" />

// String Processing
export function processString(input: string, options?: Record<string, boolean>): Promise<string>;
export function batchProcess(
  inputs: string[],
  options?: Record<string, boolean>,
): Promise<string[]>;
export function textStats(text: string): {
  characters: number;
  characters_no_spaces: number;
  words: number;
  lines: number;
  bytes: number;
};

// Cryptography
export function computeHash(data: string, algorithm?: string): string;
export function hashFile(path: string, algorithm?: string): string;
export function randomBytes(length: number): Buffer;
export function generateUuid(): string;
export function generateUuids(count: number): string[];
export function secureRandom(length: number): string;
export function batchHash(inputs: string[], algorithm?: string): string[];
export function benchmarkCrypto(
  operation: string,
  iterations?: number,
): Promise<{ operation: string; iterations: number; duration_ms: number; ops_per_second: number }>;

// AES-256-GCM
export function aes256GcmEncrypt(
  plaintext: string,
  keyHex: string,
  nonceHex?: string,
): Promise<{ ciphertext: string; nonce: string; tag?: string }>;
export function aes256GcmDecrypt(
  ciphertextHex: string,
  keyHex: string,
  nonceHex: string,
): Promise<{ plaintext: string; success: boolean; error?: string }>;

// Argon2
export function argon2Hash(password: string, salt?: string): Promise<string>;
export function argon2Verify(password: string, hash: string): Promise<boolean>;

// HMAC/HKDF
export function hmacCompute(data: string, key: string, algorithm?: string): string;
export function hkdfDerive(inputKey: string, salt: string, info: string, length?: number): string;
export function sha256Hash(data: string, salt?: string): string;
export function blake3HashKeyed(data: string, key?: string): string;

// File Operations
export function getFileInfo(path: string): {
  exists: boolean;
  is_file: boolean;
  is_dir: boolean;
  size?: number;
  readonly?: boolean;
  name?: string;
  extension?: string;
  error?: string;
};
export function readFileString(path: string): string;
export function readFileBuffer(path: string): Buffer;
export function writeFileBuffer(path: string, content: Buffer): void;
export function listDirectory(
  path: string,
): Array<{ name: string; path: string; is_file: boolean; is_dir: boolean; size?: number }>;
export function createDirectory(path: string): void;
export function deleteFile(path: string): void;
export function deleteDirectory(path: string): void;
export function copyFile(from: string, to: string): number;

// Encoding
export function base64Encode(input: string): string;
export function base64Decode(input: string): string;
export function urlEncode(input: string): string;
export function urlDecode(input: string): string;
export function hexEncode(input: Buffer): string;
export function hexDecode(input: string): Buffer;

// JSON Operations
export function validateJson(json_string: string): { valid: boolean; error?: string };
export function processJson(
  json_string: string,
): Promise<{ success: boolean; data?: string; error?: string }>;
export function minifyJson(json_string: string): Promise<string>;
export function prettifyJson(json_string: string, indent?: number): Promise<string>;

// Regex Operations
export function regexFind(
  text: string,
  pattern: string,
): { matched: boolean; matches: string[]; count: number };
export function regexReplace(text: string, pattern: string, replacement: string): string;
export function regexTest(text: string, pattern: string): boolean;

// Plugin Info
export function getPluginInfo(): {
  name: string;
  version: string;
  rust_version: string;
  target_triple: string;
  features: string[];
};
export function healthCheck(): string;
export function benchmark(iterations: number): number;

// Webhook
export function handleWebhook(
  body: string,
): Promise<{ status_code: number; body: string; processed: boolean }>;

// Data Processing
export function rleCompress(data: string): {
  compressed: string;
  original_size: number;
  compressed_size: number;
  ratio: number;
};
export function rleDecompress(compressed: string): {
  data: string;
  success: boolean;
  error?: string;
};
export function tokenize(text: string, mode?: string): string[];
export function extendedTextStats(text: string): {
  characters: number;
  characters_no_spaces: number;
  words: number;
  lines: number;
  paragraphs: number;
  sentences: number;
  avg_word_length: number;
  avg_sentence_length: number;
};
export function transformText(text: string, operations: string[]): string;
export function patternMatch(text: string, pattern: string): boolean;
export function validateData(
  data: string,
  rules: Record<string, string>,
): { is_valid: boolean; errors: string[] };
export function levenshteinDistance(string1: string, string2: string): number;
export function findReplace(
  text: string,
  pattern: string,
  replacement: string,
  useRegex?: boolean,
): string;
export function deduplicate(items: string[], caseSensitive?: boolean): string[];

// Parallel Processing
export function parallelProcessItems(items: string[], operation: string): string[];
export function processBufferAsync(buffer: Buffer): Promise<Buffer>;
export function processTypedArray(input: Uint32Array): Uint32Array;
export function floatArrayStats(input: Float64Array): {
  min: number;
  max: number;
  avg: number;
  sum: number;
  count: number;
};
export function cancellableOperation(input: string, signal?: AbortSignal): Promise<string>;
export function complexDataAsync(data: Uint8Array): Promise<Buffer>;
export function fallibleComplexOperation(input: string): {
  success: boolean;
  processed_length: number;
  hash: string;
  metadata?: { timestamp: string; complexity: number };
};

// Classes
export class DataProcessor {
  constructor();
  static withCapacity(capacity: number): DataProcessor;
  append(data: Buffer): void;
  appendString(data: string): void;
  process(): Buffer;
  clear(): void;
  len(): number;
  isEmpty(): boolean;
  toString(): string;
  toBase64(): string;
  fromBase64(encoded: string): void;
  hash(algorithm?: string): string;
}

export class SharedStateProcessor {
  constructor();
  addData(data: Buffer): void;
  getData(): Buffer;
  clear(): void;
}
