import WebSocket from "ws";
import { Readable } from "stream";
import { EventEmitter as EventEmitter$1 } from "events";
import { URL } from "url";
import { Agent } from "https";

//#region node_modules/baileys/lib/Utils/logger.d.ts
interface ILogger {
  level: string;
  child(obj: Record<string, unknown>): ILogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}
//#endregion
//#region node_modules/protobufjs/index.d.ts
/** Wire format reader using `Uint8Array` if available, otherwise `Array`. */
declare class Reader {
  /**
   * Constructs a new reader instance using the specified buffer.
   * @param buffer Buffer to read from
   */
  constructor(buffer: Uint8Array);
  /** Read buffer. */
  public buf: Uint8Array;
  /** Read buffer position. */
  public pos: number;
  /** Read buffer length. */
  public len: number;
  /**
   * Creates a new reader using the specified buffer.
   * @param buffer Buffer to read from
   * @returns A {@link BufferReader} if `buffer` is a Buffer, otherwise a {@link Reader}
   * @throws {Error} If `buffer` is not a valid buffer
   */
  public static create(buffer: (Uint8Array | Buffer$1)): (Reader | BufferReader);
  /**
   * Reads a varint as an unsigned 32 bit value.
   * @returns Value read
   */
  public uint32(): number;
  /**
   * Reads a varint as a signed 32 bit value.
   * @returns Value read
   */
  public int32(): number;
  /**
   * Reads a zig-zag encoded varint as a signed 32 bit value.
   * @returns Value read
   */
  public sint32(): number;
  /**
   * Reads a varint as a signed 64 bit value.
   * @returns Value read
   */
  public int64(): Long$2;
  /**
   * Reads a varint as an unsigned 64 bit value.
   * @returns Value read
   */
  public uint64(): Long$2;
  /**
   * Reads a zig-zag encoded varint as a signed 64 bit value.
   * @returns Value read
   */
  public sint64(): Long$2;
  /**
   * Reads a varint as a boolean.
   * @returns Value read
   */
  public bool(): boolean;
  /**
   * Reads fixed 32 bits as an unsigned 32 bit integer.
   * @returns Value read
   */
  public fixed32(): number;
  /**
   * Reads fixed 32 bits as a signed 32 bit integer.
   * @returns Value read
   */
  public sfixed32(): number;
  /**
   * Reads fixed 64 bits.
   * @returns Value read
   */
  public fixed64(): Long$2;
  /**
   * Reads zig-zag encoded fixed 64 bits.
   * @returns Value read
   */
  public sfixed64(): Long$2;
  /**
   * Reads a float (32 bit) as a number.
   * @returns Value read
   */
  public float(): number;
  /**
   * Reads a double (64 bit float) as a number.
   * @returns Value read
   */
  public double(): number;
  /**
   * Reads a sequence of bytes preceeded by its length as a varint.
   * @returns Value read
   */
  public bytes(): Uint8Array;
  /**
   * Reads a string preceeded by its byte length as a varint.
   * @returns Value read
   */
  public string(): string;
  /**
   * Skips the specified number of bytes if specified, otherwise skips a varint.
   * @param [length] Length if known, otherwise a varint is assumed
   * @returns `this`
   */
  public skip(length?: number): Reader;
  /** Recursion limit. */
  public static recursionLimit: number;
  /**
   * Skips the next element of the specified wire type.
   * @param wireType Wire type received
   * @param [depth] Depth of recursion to control nested calls; 0 if omitted
   * @returns `this`
   */
  public skipType(wireType: number, depth?: number): Reader;
}
/** Wire format reader using node buffers. */
declare class BufferReader extends Reader {
  /**
   * Constructs a new buffer reader instance.
   * @param buffer Buffer to read from
   */
  constructor(buffer: Buffer$1);
  /**
   * Reads a sequence of bytes preceeded by its length as a varint.
   * @returns Value read
   */
  public bytes(): Buffer$1;
}
/** Conversion options as used by {@link Type#toObject} and {@link Message.toObject}. */
interface IConversionOptions {
  /**
   * Long conversion type.
   * Valid values are `String` and `Number` (the global types).
   * Defaults to copy the present value, which is a possibly unsafe number without and a {@link Long} with a long library.
   */
  longs?: Function;
  /**
   * Enum value conversion type.
   * Only valid value is `String` (the global type).
   * Defaults to copy the present value, which is the numeric id.
   */
  enums?: Function;
  /**
   * Bytes value conversion type.
   * Valid values are `Array` and (a base64 encoded) `String` (the global types).
   * Defaults to copy the present value, which usually is a Buffer under node and an Uint8Array in the browser.
   */
  bytes?: Function;
  /** Also sets default values on the resulting object */
  defaults?: boolean;
  /** Sets empty arrays for missing repeated fields even if `defaults=false` */
  arrays?: boolean;
  /** Sets empty objects for missing map fields even if `defaults=false` */
  objects?: boolean;
  /** Includes virtual oneof properties set to the present field's name, if any */
  oneofs?: boolean;
  /** Performs additional JSON compatibility conversions, i.e. NaN and Infinity to strings */
  json?: boolean;
}
/**
 * Any compatible Buffer instance.
 * This is a minimal stand-alone definition of a Buffer instance. The actual type is that exported by node's typings.
 */
interface Buffer$1 extends Uint8Array {}
/**
 * Any compatible Long instance.
 * This is a minimal stand-alone definition of a Long instance. The actual type is that exported by long.js.
 */
interface Long$2 {
  /** Low bits */
  low: number;
  /** High bits */
  high: number;
  /** Whether unsigned or not */
  unsigned: boolean;
}
/** Wire format writer using `Uint8Array` if available, otherwise `Array`. */
declare class Writer {
  /** Constructs a new writer instance. */
  constructor();
  /** Current length. */
  public len: number;
  /** Operations head. */
  public head: object;
  /** Operations tail */
  public tail: object;
  /** Linked forked states. */
  public states: (object | null);
  /**
   * Creates a new writer.
   * @returns A {@link BufferWriter} when Buffers are supported, otherwise a {@link Writer}
   */
  public static create(): (BufferWriter | Writer);
  /**
   * Allocates a buffer of the specified size.
   * @param size Buffer size
   * @returns Buffer
   */
  public static alloc(size: number): Uint8Array;
  /**
   * Writes an unsigned 32 bit value as a varint.
   * @param value Value to write
   * @returns `this`
   */
  public uint32(value: number): Writer;
  /**
   * Writes a signed 32 bit value as a varint.
   * @param value Value to write
   * @returns `this`
   */
  public int32(value: number): Writer;
  /**
   * Writes a 32 bit value as a varint, zig-zag encoded.
   * @param value Value to write
   * @returns `this`
   */
  public sint32(value: number): Writer;
  /**
   * Writes an unsigned 64 bit value as a varint.
   * @param value Value to write
   * @returns `this`
   * @throws {TypeError} If `value` is a string and no long library is present.
   */
  public uint64(value: (Long$2 | number | string)): Writer;
  /**
   * Writes a signed 64 bit value as a varint.
   * @param value Value to write
   * @returns `this`
   * @throws {TypeError} If `value` is a string and no long library is present.
   */
  public int64(value: (Long$2 | number | string)): Writer;
  /**
   * Writes a signed 64 bit value as a varint, zig-zag encoded.
   * @param value Value to write
   * @returns `this`
   * @throws {TypeError} If `value` is a string and no long library is present.
   */
  public sint64(value: (Long$2 | number | string)): Writer;
  /**
   * Writes a boolish value as a varint.
   * @param value Value to write
   * @returns `this`
   */
  public bool(value: boolean): Writer;
  /**
   * Writes an unsigned 32 bit value as fixed 32 bits.
   * @param value Value to write
   * @returns `this`
   */
  public fixed32(value: number): Writer;
  /**
   * Writes a signed 32 bit value as fixed 32 bits.
   * @param value Value to write
   * @returns `this`
   */
  public sfixed32(value: number): Writer;
  /**
   * Writes an unsigned 64 bit value as fixed 64 bits.
   * @param value Value to write
   * @returns `this`
   * @throws {TypeError} If `value` is a string and no long library is present.
   */
  public fixed64(value: (Long$2 | number | string)): Writer;
  /**
   * Writes a signed 64 bit value as fixed 64 bits.
   * @param value Value to write
   * @returns `this`
   * @throws {TypeError} If `value` is a string and no long library is present.
   */
  public sfixed64(value: (Long$2 | number | string)): Writer;
  /**
   * Writes a float (32 bit).
   * @param value Value to write
   * @returns `this`
   */
  public float(value: number): Writer;
  /**
   * Writes a double (64 bit float).
   * @param value Value to write
   * @returns `this`
   */
  public double(value: number): Writer;
  /**
   * Writes a sequence of bytes.
   * @param value Buffer or base64 encoded string to write
   * @returns `this`
   */
  public bytes(value: (Uint8Array | string)): Writer;
  /**
   * Writes a string.
   * @param value Value to write
   * @returns `this`
   */
  public string(value: string): Writer;
  /**
   * Forks this writer's state by pushing it to a stack.
   * Calling {@link Writer#reset|reset} or {@link Writer#ldelim|ldelim} resets the writer to the previous state.
   * @returns `this`
   */
  public fork(): Writer;
  /**
   * Resets this instance to the last state.
   * @returns `this`
   */
  public reset(): Writer;
  /**
   * Resets to the last state and appends the fork state's current write length as a varint followed by its operations.
   * @returns `this`
   */
  public ldelim(): Writer;
  /**
   * Finishes the write operation.
   * @returns Finished buffer
   */
  public finish(): Uint8Array;
}
/** Wire format writer using node buffers. */
declare class BufferWriter extends Writer {
  /** Constructs a new buffer writer instance. */
  constructor();
  /**
   * Allocates a buffer of the specified size.
   * @param size Buffer size
   * @returns Buffer
   */
  public static alloc(size: number): Buffer$1;
  /**
   * Finishes the write operation.
   * @returns Finished buffer
   */
  public finish(): Buffer$1;
}
//#endregion
//#region node_modules/long/types.d.ts
// Common type definitions for both the ESM and UMD variants. The ESM variant
// reexports the Long class as its default export, whereas the UMD variant makes
// the Long class a whole-module export with a global variable fallback.
type LongLike = Long$1 | number | bigint | string | {
  low: number;
  high: number;
  unsigned: boolean;
};
declare class Long$1 {
  /**
   * Constructs a 64 bit two's-complement integer, given its low and high 32 bit values as signed integers. See the from* functions below for more convenient ways of constructing Longs.
   */
  constructor(low: number, high?: number, unsigned?: boolean);
  /**
   * Maximum unsigned value.
   */
  static MAX_UNSIGNED_VALUE: Long$1;
  /**
   * Maximum signed value.
   */
  static MAX_VALUE: Long$1;
  /**
   * Minimum signed value.
   */
  static MIN_VALUE: Long$1;
  /**
   * Signed negative one.
   */
  static NEG_ONE: Long$1;
  /**
   * Signed one.
   */
  static ONE: Long$1;
  /**
   * Unsigned one.
   */
  static UONE: Long$1;
  /**
   * Unsigned zero.
   */
  static UZERO: Long$1;
  /**
   * Signed zero
   */
  static ZERO: Long$1;
  /**
   * The high 32 bits as a signed value.
   */
  high: number;
  /**
   * The low 32 bits as a signed value.
   */
  low: number;
  /**
   * Whether unsigned or not.
   */
  unsigned: boolean;
  /**
   * Returns a Long representing the 64 bit integer that comes by concatenating the given low and high bits. Each is assumed to use 32 bits.
   */
  static fromBits(lowBits: number, highBits: number, unsigned?: boolean): Long$1;
  /**
   * Returns a Long representing the given 32 bit integer value.
   */
  static fromInt(value: number, unsigned?: boolean): Long$1;
  /**
   * Returns a Long representing the given value, provided that it is a finite number. Otherwise, zero is returned.
   */
  static fromNumber(value: number, unsigned?: boolean): Long$1;
  /**
   * Returns a Long representing the given big integer value.
   */
  static fromBigInt(value: bigint, unsigned?: boolean): Long$1;
  /**
   * Returns a Long representation of the given string, written using the specified radix.
   */
  static fromString(str: string, unsigned?: boolean | number, radix?: number): Long$1;
  /**
   * Creates a Long from its byte representation.
   */
  static fromBytes(bytes: number[], unsigned?: boolean, le?: boolean): Long$1;
  /**
   * Creates a Long from its little endian byte representation.
   */
  static fromBytesLE(bytes: number[], unsigned?: boolean): Long$1;
  /**
   * Creates a Long from its big endian byte representation.
   */
  static fromBytesBE(bytes: number[], unsigned?: boolean): Long$1;
  /**
   * Tests if the specified object is a Long.
   */
  static isLong(obj: any): obj is Long$1;
  /**
   * Converts the specified value to a Long.
   */
  static fromValue(val: LongLike, unsigned?: boolean): Long$1;
  /**
   * Returns the sum of this and the specified Long.
   */
  add(addend: LongLike): Long$1;
  /**
   * Returns the bitwise AND of this Long and the specified.
   */
  and(other: LongLike): Long$1;
  /**
   * Compares this Long's value with the specified's.
   */
  compare(other: LongLike): number;
  /**
   * Compares this Long's value with the specified's.
   */
  comp(other: LongLike): number;
  /**
   * Returns this Long divided by the specified.
   */
  divide(divisor: LongLike): Long$1;
  /**
   * Returns this Long divided by the specified.
   */
  div(divisor: LongLike): Long$1;
  /**
   * Tests if this Long's value equals the specified's.
   */
  equals(other: LongLike): boolean;
  /**
   * Tests if this Long's value equals the specified's.
   */
  eq(other: LongLike): boolean;
  /**
   * Gets the high 32 bits as a signed integer.
   */
  getHighBits(): number;
  /**
   * Gets the high 32 bits as an unsigned integer.
   */
  getHighBitsUnsigned(): number;
  /**
   * Gets the low 32 bits as a signed integer.
   */
  getLowBits(): number;
  /**
   * Gets the low 32 bits as an unsigned integer.
   */
  getLowBitsUnsigned(): number;
  /**
   * Gets the number of bits needed to represent the absolute value of this Long.
   */
  getNumBitsAbs(): number;
  /**
   * Tests if this Long's value is greater than the specified's.
   */
  greaterThan(other: LongLike): boolean;
  /**
   * Tests if this Long's value is greater than the specified's.
   */
  gt(other: LongLike): boolean;
  /**
   * Tests if this Long's value is greater than or equal the specified's.
   */
  greaterThanOrEqual(other: LongLike): boolean;
  /**
   * Tests if this Long's value is greater than or equal the specified's.
   */
  gte(other: LongLike): boolean;
  /**
   * Tests if this Long's value is greater than or equal the specified's.
   */
  ge(other: LongLike): boolean;
  /**
   * Tests if this Long's value is even.
   */
  isEven(): boolean;
  /**
   * Tests if this Long's value is negative.
   */
  isNegative(): boolean;
  /**
   * Tests if this Long's value is odd.
   */
  isOdd(): boolean;
  /**
   * Tests if this Long's value is positive or zero.
   */
  isPositive(): boolean;
  /**
   * Tests if this Long can be safely represented as a JavaScript number.
   */
  isSafeInteger(): boolean;
  /**
   * Tests if this Long's value equals zero.
   */
  isZero(): boolean;
  /**
   * Tests if this Long's value equals zero.
   */
  eqz(): boolean;
  /**
   * Tests if this Long's value is less than the specified's.
   */
  lessThan(other: LongLike): boolean;
  /**
   * Tests if this Long's value is less than the specified's.
   */
  lt(other: LongLike): boolean;
  /**
   * Tests if this Long's value is less than or equal the specified's.
   */
  lessThanOrEqual(other: LongLike): boolean;
  /**
   * Tests if this Long's value is less than or equal the specified's.
   */
  lte(other: LongLike): boolean;
  /**
   * Tests if this Long's value is less than or equal the specified's.
   */
  le(other: LongLike): boolean;
  /**
   * Returns this Long modulo the specified.
   */
  modulo(other: LongLike): Long$1;
  /**
   * Returns this Long modulo the specified.
   */
  mod(other: LongLike): Long$1;
  /**
   * Returns this Long modulo the specified.
   */
  rem(other: LongLike): Long$1;
  /**
   * Returns the product of this and the specified Long.
   */
  multiply(multiplier: LongLike): Long$1;
  /**
   * Returns the product of this and the specified Long.
   */
  mul(multiplier: LongLike): Long$1;
  /**
   * Negates this Long's value.
   */
  negate(): Long$1;
  /**
   * Negates this Long's value.
   */
  neg(): Long$1;
  /**
   * Returns the bitwise NOT of this Long.
   */
  not(): Long$1;
  /**
   * Returns count leading zeros of this Long.
   */
  countLeadingZeros(): number;
  /**
   * Returns count leading zeros of this Long.
   */
  clz(): number;
  /**
   * Returns count trailing zeros of this Long.
   */
  countTrailingZeros(): number;
  /**
   * Returns count trailing zeros of this Long.
   */
  ctz(): number;
  /**
   * Tests if this Long's value differs from the specified's.
   */
  notEquals(other: LongLike): boolean;
  /**
   * Tests if this Long's value differs from the specified's.
   */
  neq(other: LongLike): boolean;
  /**
   * Tests if this Long's value differs from the specified's.
   */
  ne(other: LongLike): boolean;
  /**
   * Returns the bitwise OR of this Long and the specified.
   */
  or(other: LongLike): Long$1;
  /**
   * Returns this Long with bits shifted to the left by the given amount.
   */
  shiftLeft(numBits: number | Long$1): Long$1;
  /**
   * Returns this Long with bits shifted to the left by the given amount.
   */
  shl(numBits: number | Long$1): Long$1;
  /**
   * Returns this Long with bits arithmetically shifted to the right by the given amount.
   */
  shiftRight(numBits: number | Long$1): Long$1;
  /**
   * Returns this Long with bits arithmetically shifted to the right by the given amount.
   */
  shr(numBits: number | Long$1): Long$1;
  /**
   * Returns this Long with bits logically shifted to the right by the given amount.
   */
  shiftRightUnsigned(numBits: number | Long$1): Long$1;
  /**
   * Returns this Long with bits logically shifted to the right by the given amount.
   */
  shru(numBits: number | Long$1): Long$1;
  /**
   * Returns this Long with bits logically shifted to the right by the given amount.
   */
  shr_u(numBits: number | Long$1): Long$1;
  /**
   * Returns this Long with bits rotated to the left by the given amount.
   */
  rotateLeft(numBits: number | Long$1): Long$1;
  /**
   * Returns this Long with bits rotated to the left by the given amount.
   */
  rotl(numBits: number | Long$1): Long$1;
  /**
   * Returns this Long with bits rotated to the right by the given amount.
   */
  rotateRight(numBits: number | Long$1): Long$1;
  /**
   * Returns this Long with bits rotated to the right by the given amount.
   */
  rotr(numBits: number | Long$1): Long$1;
  /**
   * Returns the difference of this and the specified Long.
   */
  subtract(subtrahend: LongLike): Long$1;
  /**
   * Returns the difference of this and the specified Long.
   */
  sub(subtrahend: LongLike): Long$1;
  /**
   * Converts the Long to a big integer.
   */
  toBigInt(): bigint;
  /**
   * Converts the Long to a 32 bit integer, assuming it is a 32 bit integer.
   */
  toInt(): number;
  /**
   * Converts the Long to a the nearest floating-point representation of this value (double, 53 bit mantissa).
   */
  toNumber(): number;
  /**
   * Converts this Long to its byte representation.
   */
  toBytes(le?: boolean): number[];
  /**
   * Converts this Long to its little endian byte representation.
   */
  toBytesLE(): number[];
  /**
   * Converts this Long to its big endian byte representation.
   */
  toBytesBE(): number[];
  /**
   * Converts this Long to signed.
   */
  toSigned(): Long$1;
  /**
   * Converts the Long to a string written in the specified radix.
   */
  toString(radix?: number): string;
  /**
   * Converts this Long to unsigned.
   */
  toUnsigned(): Long$1;
  /**
   * Returns the bitwise XOR of this Long and the given one.
   */
  xor(other: LongLike): Long$1;
}
//#endregion
//#region node_modules/baileys/WAProto/index.d.ts
declare namespace proto {
  interface IADVDeviceIdentity {
    rawId?: (number | null);
    timestamp?: (number | Long$1 | null);
    keyIndex?: (number | null);
    accountType?: (proto.ADVEncryptionType | null);
    deviceType?: (proto.ADVEncryptionType | null);
  }
  class ADVDeviceIdentity implements IADVDeviceIdentity {
    constructor(p?: proto.IADVDeviceIdentity);
    public rawId?: (number | null);
    public timestamp?: (number | Long$1 | null);
    public keyIndex?: (number | null);
    public accountType?: (proto.ADVEncryptionType | null);
    public deviceType?: (proto.ADVEncryptionType | null);
    public static create(properties?: proto.IADVDeviceIdentity): proto.ADVDeviceIdentity;
    public static encode(m: proto.IADVDeviceIdentity, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ADVDeviceIdentity;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ADVDeviceIdentity;
    public static toObject(m: proto.ADVDeviceIdentity, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  enum ADVEncryptionType {
    E2EE = 0,
    HOSTED = 1
  }
  interface IADVKeyIndexList {
    rawId?: (number | null);
    timestamp?: (number | Long$1 | null);
    currentIndex?: (number | null);
    validIndexes?: (number[] | null);
    accountType?: (proto.ADVEncryptionType | null);
  }
  class ADVKeyIndexList implements IADVKeyIndexList {
    constructor(p?: proto.IADVKeyIndexList);
    public rawId?: (number | null);
    public timestamp?: (number | Long$1 | null);
    public currentIndex?: (number | null);
    public validIndexes: number[];
    public accountType?: (proto.ADVEncryptionType | null);
    public static create(properties?: proto.IADVKeyIndexList): proto.ADVKeyIndexList;
    public static encode(m: proto.IADVKeyIndexList, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ADVKeyIndexList;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ADVKeyIndexList;
    public static toObject(m: proto.ADVKeyIndexList, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IADVSignedDeviceIdentity {
    details?: (Uint8Array | null);
    accountSignatureKey?: (Uint8Array | null);
    accountSignature?: (Uint8Array | null);
    deviceSignature?: (Uint8Array | null);
  }
  class ADVSignedDeviceIdentity implements IADVSignedDeviceIdentity {
    constructor(p?: proto.IADVSignedDeviceIdentity);
    public details?: (Uint8Array | null);
    public accountSignatureKey?: (Uint8Array | null);
    public accountSignature?: (Uint8Array | null);
    public deviceSignature?: (Uint8Array | null);
    public static create(properties?: proto.IADVSignedDeviceIdentity): proto.ADVSignedDeviceIdentity;
    public static encode(m: proto.IADVSignedDeviceIdentity, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ADVSignedDeviceIdentity;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ADVSignedDeviceIdentity;
    public static toObject(m: proto.ADVSignedDeviceIdentity, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IADVSignedDeviceIdentityHMAC {
    details?: (Uint8Array | null);
    hmac?: (Uint8Array | null);
    accountType?: (proto.ADVEncryptionType | null);
  }
  class ADVSignedDeviceIdentityHMAC implements IADVSignedDeviceIdentityHMAC {
    constructor(p?: proto.IADVSignedDeviceIdentityHMAC);
    public details?: (Uint8Array | null);
    public hmac?: (Uint8Array | null);
    public accountType?: (proto.ADVEncryptionType | null);
    public static create(properties?: proto.IADVSignedDeviceIdentityHMAC): proto.ADVSignedDeviceIdentityHMAC;
    public static encode(m: proto.IADVSignedDeviceIdentityHMAC, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ADVSignedDeviceIdentityHMAC;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ADVSignedDeviceIdentityHMAC;
    public static toObject(m: proto.ADVSignedDeviceIdentityHMAC, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IADVSignedKeyIndexList {
    details?: (Uint8Array | null);
    accountSignature?: (Uint8Array | null);
    accountSignatureKey?: (Uint8Array | null);
  }
  class ADVSignedKeyIndexList implements IADVSignedKeyIndexList {
    constructor(p?: proto.IADVSignedKeyIndexList);
    public details?: (Uint8Array | null);
    public accountSignature?: (Uint8Array | null);
    public accountSignatureKey?: (Uint8Array | null);
    public static create(properties?: proto.IADVSignedKeyIndexList): proto.ADVSignedKeyIndexList;
    public static encode(m: proto.IADVSignedKeyIndexList, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ADVSignedKeyIndexList;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ADVSignedKeyIndexList;
    public static toObject(m: proto.ADVSignedKeyIndexList, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IAIHomeState {
    lastFetchTime?: (number | Long$1 | null);
    capabilityOptions?: (proto.AIHomeState.IAIHomeOption[] | null);
    conversationOptions?: (proto.AIHomeState.IAIHomeOption[] | null);
  }
  class AIHomeState implements IAIHomeState {
    constructor(p?: proto.IAIHomeState);
    public lastFetchTime?: (number | Long$1 | null);
    public capabilityOptions: proto.AIHomeState.IAIHomeOption[];
    public conversationOptions: proto.AIHomeState.IAIHomeOption[];
    public static create(properties?: proto.IAIHomeState): proto.AIHomeState;
    public static encode(m: proto.IAIHomeState, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIHomeState;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIHomeState;
    public static toObject(m: proto.AIHomeState, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace AIHomeState {
    interface IAIHomeOption {
      type?: (proto.AIHomeState.AIHomeOption.AIHomeActionType | null);
      title?: (string | null);
      promptText?: (string | null);
      sessionId?: (string | null);
      imageWdsIdentifier?: (string | null);
      imageTintColor?: (string | null);
      imageBackgroundColor?: (string | null);
    }
    class AIHomeOption implements IAIHomeOption {
      constructor(p?: proto.AIHomeState.IAIHomeOption);
      public type?: (proto.AIHomeState.AIHomeOption.AIHomeActionType | null);
      public title?: (string | null);
      public promptText?: (string | null);
      public sessionId?: (string | null);
      public imageWdsIdentifier?: (string | null);
      public imageTintColor?: (string | null);
      public imageBackgroundColor?: (string | null);
      public static create(properties?: proto.AIHomeState.IAIHomeOption): proto.AIHomeState.AIHomeOption;
      public static encode(m: proto.AIHomeState.IAIHomeOption, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.AIHomeState.AIHomeOption;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.AIHomeState.AIHomeOption;
      public static toObject(m: proto.AIHomeState.AIHomeOption, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace AIHomeOption {
      enum AIHomeActionType {
        PROMPT = 0,
        CREATE_IMAGE = 1,
        ANIMATE_PHOTO = 2,
        ANALYZE_FILE = 3
      }
    }
  }
  interface IAIQueryFanout {
    messageKey?: (proto.IMessageKey | null);
    message?: (proto.IMessage | null);
    timestamp?: (number | Long$1 | null);
  }
  class AIQueryFanout implements IAIQueryFanout {
    constructor(p?: proto.IAIQueryFanout);
    public messageKey?: (proto.IMessageKey | null);
    public message?: (proto.IMessage | null);
    public timestamp?: (number | Long$1 | null);
    public static create(properties?: proto.IAIQueryFanout): proto.AIQueryFanout;
    public static encode(m: proto.IAIQueryFanout, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIQueryFanout;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIQueryFanout;
    public static toObject(m: proto.AIQueryFanout, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IAIRegenerateMetadata {
    messageKey?: (proto.IMessageKey | null);
    responseTimestampMs?: (number | Long$1 | null);
  }
  class AIRegenerateMetadata implements IAIRegenerateMetadata {
    constructor(p?: proto.IAIRegenerateMetadata);
    public messageKey?: (proto.IMessageKey | null);
    public responseTimestampMs?: (number | Long$1 | null);
    public static create(properties?: proto.IAIRegenerateMetadata): proto.AIRegenerateMetadata;
    public static encode(m: proto.IAIRegenerateMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRegenerateMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRegenerateMetadata;
    public static toObject(m: proto.AIRegenerateMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IAIRichResponseCodeMetadata {
    codeLanguage?: (string | null);
    codeBlocks?: (proto.AIRichResponseCodeMetadata.IAIRichResponseCodeBlock[] | null);
  }
  class AIRichResponseCodeMetadata implements IAIRichResponseCodeMetadata {
    constructor(p?: proto.IAIRichResponseCodeMetadata);
    public codeLanguage?: (string | null);
    public codeBlocks: proto.AIRichResponseCodeMetadata.IAIRichResponseCodeBlock[];
    public static create(properties?: proto.IAIRichResponseCodeMetadata): proto.AIRichResponseCodeMetadata;
    public static encode(m: proto.IAIRichResponseCodeMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseCodeMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseCodeMetadata;
    public static toObject(m: proto.AIRichResponseCodeMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace AIRichResponseCodeMetadata {
    interface IAIRichResponseCodeBlock {
      highlightType?: (proto.AIRichResponseCodeMetadata.AIRichResponseCodeHighlightType | null);
      codeContent?: (string | null);
    }
    class AIRichResponseCodeBlock implements IAIRichResponseCodeBlock {
      constructor(p?: proto.AIRichResponseCodeMetadata.IAIRichResponseCodeBlock);
      public highlightType?: (proto.AIRichResponseCodeMetadata.AIRichResponseCodeHighlightType | null);
      public codeContent?: (string | null);
      public static create(properties?: proto.AIRichResponseCodeMetadata.IAIRichResponseCodeBlock): proto.AIRichResponseCodeMetadata.AIRichResponseCodeBlock;
      public static encode(m: proto.AIRichResponseCodeMetadata.IAIRichResponseCodeBlock, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseCodeMetadata.AIRichResponseCodeBlock;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.AIRichResponseCodeMetadata.AIRichResponseCodeBlock;
      public static toObject(m: proto.AIRichResponseCodeMetadata.AIRichResponseCodeBlock, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum AIRichResponseCodeHighlightType {
      AI_RICH_RESPONSE_CODE_HIGHLIGHT_DEFAULT = 0,
      AI_RICH_RESPONSE_CODE_HIGHLIGHT_KEYWORD = 1,
      AI_RICH_RESPONSE_CODE_HIGHLIGHT_METHOD = 2,
      AI_RICH_RESPONSE_CODE_HIGHLIGHT_STRING = 3,
      AI_RICH_RESPONSE_CODE_HIGHLIGHT_NUMBER = 4,
      AI_RICH_RESPONSE_CODE_HIGHLIGHT_COMMENT = 5
    }
  }
  interface IAIRichResponseContentItemsMetadata {
    itemsMetadata?: (proto.AIRichResponseContentItemsMetadata.IAIRichResponseContentItemMetadata[] | null);
    contentType?: (proto.AIRichResponseContentItemsMetadata.ContentType | null);
  }
  class AIRichResponseContentItemsMetadata implements IAIRichResponseContentItemsMetadata {
    constructor(p?: proto.IAIRichResponseContentItemsMetadata);
    public itemsMetadata: proto.AIRichResponseContentItemsMetadata.IAIRichResponseContentItemMetadata[];
    public contentType?: (proto.AIRichResponseContentItemsMetadata.ContentType | null);
    public static create(properties?: proto.IAIRichResponseContentItemsMetadata): proto.AIRichResponseContentItemsMetadata;
    public static encode(m: proto.IAIRichResponseContentItemsMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseContentItemsMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseContentItemsMetadata;
    public static toObject(m: proto.AIRichResponseContentItemsMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace AIRichResponseContentItemsMetadata {
    interface IAIRichResponseContentItemMetadata {
      reelItem?: (proto.AIRichResponseContentItemsMetadata.IAIRichResponseReelItem | null);
    }
    class AIRichResponseContentItemMetadata implements IAIRichResponseContentItemMetadata {
      constructor(p?: proto.AIRichResponseContentItemsMetadata.IAIRichResponseContentItemMetadata);
      public reelItem?: (proto.AIRichResponseContentItemsMetadata.IAIRichResponseReelItem | null);
      public aIRichResponseContentItem?: "reelItem";
      public static create(properties?: proto.AIRichResponseContentItemsMetadata.IAIRichResponseContentItemMetadata): proto.AIRichResponseContentItemsMetadata.AIRichResponseContentItemMetadata;
      public static encode(m: proto.AIRichResponseContentItemsMetadata.IAIRichResponseContentItemMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseContentItemsMetadata.AIRichResponseContentItemMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.AIRichResponseContentItemsMetadata.AIRichResponseContentItemMetadata;
      public static toObject(m: proto.AIRichResponseContentItemsMetadata.AIRichResponseContentItemMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAIRichResponseReelItem {
      title?: (string | null);
      profileIconUrl?: (string | null);
      thumbnailUrl?: (string | null);
      videoUrl?: (string | null);
    }
    class AIRichResponseReelItem implements IAIRichResponseReelItem {
      constructor(p?: proto.AIRichResponseContentItemsMetadata.IAIRichResponseReelItem);
      public title?: (string | null);
      public profileIconUrl?: (string | null);
      public thumbnailUrl?: (string | null);
      public videoUrl?: (string | null);
      public static create(properties?: proto.AIRichResponseContentItemsMetadata.IAIRichResponseReelItem): proto.AIRichResponseContentItemsMetadata.AIRichResponseReelItem;
      public static encode(m: proto.AIRichResponseContentItemsMetadata.IAIRichResponseReelItem, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseContentItemsMetadata.AIRichResponseReelItem;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.AIRichResponseContentItemsMetadata.AIRichResponseReelItem;
      public static toObject(m: proto.AIRichResponseContentItemsMetadata.AIRichResponseReelItem, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum ContentType {
      DEFAULT = 0,
      CAROUSEL = 1
    }
  }
  interface IAIRichResponseDynamicMetadata {
    type?: (proto.AIRichResponseDynamicMetadata.AIRichResponseDynamicMetadataType | null);
    version?: (number | Long$1 | null);
    url?: (string | null);
    loopCount?: (number | null);
  }
  class AIRichResponseDynamicMetadata implements IAIRichResponseDynamicMetadata {
    constructor(p?: proto.IAIRichResponseDynamicMetadata);
    public type?: (proto.AIRichResponseDynamicMetadata.AIRichResponseDynamicMetadataType | null);
    public version?: (number | Long$1 | null);
    public url?: (string | null);
    public loopCount?: (number | null);
    public static create(properties?: proto.IAIRichResponseDynamicMetadata): proto.AIRichResponseDynamicMetadata;
    public static encode(m: proto.IAIRichResponseDynamicMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseDynamicMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseDynamicMetadata;
    public static toObject(m: proto.AIRichResponseDynamicMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace AIRichResponseDynamicMetadata {
    enum AIRichResponseDynamicMetadataType {
      AI_RICH_RESPONSE_DYNAMIC_METADATA_TYPE_UNKNOWN = 0,
      AI_RICH_RESPONSE_DYNAMIC_METADATA_TYPE_IMAGE = 1,
      AI_RICH_RESPONSE_DYNAMIC_METADATA_TYPE_GIF = 2
    }
  }
  interface IAIRichResponseGridImageMetadata {
    gridImageUrl?: (proto.IAIRichResponseImageURL | null);
    imageUrls?: (proto.IAIRichResponseImageURL[] | null);
  }
  class AIRichResponseGridImageMetadata implements IAIRichResponseGridImageMetadata {
    constructor(p?: proto.IAIRichResponseGridImageMetadata);
    public gridImageUrl?: (proto.IAIRichResponseImageURL | null);
    public imageUrls: proto.IAIRichResponseImageURL[];
    public static create(properties?: proto.IAIRichResponseGridImageMetadata): proto.AIRichResponseGridImageMetadata;
    public static encode(m: proto.IAIRichResponseGridImageMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseGridImageMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseGridImageMetadata;
    public static toObject(m: proto.AIRichResponseGridImageMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IAIRichResponseImageURL {
    imagePreviewUrl?: (string | null);
    imageHighResUrl?: (string | null);
    sourceUrl?: (string | null);
  }
  class AIRichResponseImageURL implements IAIRichResponseImageURL {
    constructor(p?: proto.IAIRichResponseImageURL);
    public imagePreviewUrl?: (string | null);
    public imageHighResUrl?: (string | null);
    public sourceUrl?: (string | null);
    public static create(properties?: proto.IAIRichResponseImageURL): proto.AIRichResponseImageURL;
    public static encode(m: proto.IAIRichResponseImageURL, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseImageURL;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseImageURL;
    public static toObject(m: proto.AIRichResponseImageURL, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IAIRichResponseInlineImageMetadata {
    imageUrl?: (proto.IAIRichResponseImageURL | null);
    imageText?: (string | null);
    alignment?: (proto.AIRichResponseInlineImageMetadata.AIRichResponseImageAlignment | null);
    tapLinkUrl?: (string | null);
  }
  class AIRichResponseInlineImageMetadata implements IAIRichResponseInlineImageMetadata {
    constructor(p?: proto.IAIRichResponseInlineImageMetadata);
    public imageUrl?: (proto.IAIRichResponseImageURL | null);
    public imageText?: (string | null);
    public alignment?: (proto.AIRichResponseInlineImageMetadata.AIRichResponseImageAlignment | null);
    public tapLinkUrl?: (string | null);
    public static create(properties?: proto.IAIRichResponseInlineImageMetadata): proto.AIRichResponseInlineImageMetadata;
    public static encode(m: proto.IAIRichResponseInlineImageMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseInlineImageMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseInlineImageMetadata;
    public static toObject(m: proto.AIRichResponseInlineImageMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace AIRichResponseInlineImageMetadata {
    enum AIRichResponseImageAlignment {
      AI_RICH_RESPONSE_IMAGE_LAYOUT_LEADING_ALIGNED = 0,
      AI_RICH_RESPONSE_IMAGE_LAYOUT_TRAILING_ALIGNED = 1,
      AI_RICH_RESPONSE_IMAGE_LAYOUT_CENTER_ALIGNED = 2
    }
  }
  interface IAIRichResponseLatexMetadata {
    text?: (string | null);
    expressions?: (proto.AIRichResponseLatexMetadata.IAIRichResponseLatexExpression[] | null);
  }
  class AIRichResponseLatexMetadata implements IAIRichResponseLatexMetadata {
    constructor(p?: proto.IAIRichResponseLatexMetadata);
    public text?: (string | null);
    public expressions: proto.AIRichResponseLatexMetadata.IAIRichResponseLatexExpression[];
    public static create(properties?: proto.IAIRichResponseLatexMetadata): proto.AIRichResponseLatexMetadata;
    public static encode(m: proto.IAIRichResponseLatexMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseLatexMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseLatexMetadata;
    public static toObject(m: proto.AIRichResponseLatexMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace AIRichResponseLatexMetadata {
    interface IAIRichResponseLatexExpression {
      latexExpression?: (string | null);
      url?: (string | null);
      width?: (number | null);
      height?: (number | null);
      fontHeight?: (number | null);
      imageTopPadding?: (number | null);
      imageLeadingPadding?: (number | null);
      imageBottomPadding?: (number | null);
      imageTrailingPadding?: (number | null);
    }
    class AIRichResponseLatexExpression implements IAIRichResponseLatexExpression {
      constructor(p?: proto.AIRichResponseLatexMetadata.IAIRichResponseLatexExpression);
      public latexExpression?: (string | null);
      public url?: (string | null);
      public width?: (number | null);
      public height?: (number | null);
      public fontHeight?: (number | null);
      public imageTopPadding?: (number | null);
      public imageLeadingPadding?: (number | null);
      public imageBottomPadding?: (number | null);
      public imageTrailingPadding?: (number | null);
      public static create(properties?: proto.AIRichResponseLatexMetadata.IAIRichResponseLatexExpression): proto.AIRichResponseLatexMetadata.AIRichResponseLatexExpression;
      public static encode(m: proto.AIRichResponseLatexMetadata.IAIRichResponseLatexExpression, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseLatexMetadata.AIRichResponseLatexExpression;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.AIRichResponseLatexMetadata.AIRichResponseLatexExpression;
      public static toObject(m: proto.AIRichResponseLatexMetadata.AIRichResponseLatexExpression, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IAIRichResponseMapMetadata {
    centerLatitude?: (number | null);
    centerLongitude?: (number | null);
    latitudeDelta?: (number | null);
    longitudeDelta?: (number | null);
    annotations?: (proto.AIRichResponseMapMetadata.IAIRichResponseMapAnnotation[] | null);
    showInfoList?: (boolean | null);
  }
  class AIRichResponseMapMetadata implements IAIRichResponseMapMetadata {
    constructor(p?: proto.IAIRichResponseMapMetadata);
    public centerLatitude?: (number | null);
    public centerLongitude?: (number | null);
    public latitudeDelta?: (number | null);
    public longitudeDelta?: (number | null);
    public annotations: proto.AIRichResponseMapMetadata.IAIRichResponseMapAnnotation[];
    public showInfoList?: (boolean | null);
    public static create(properties?: proto.IAIRichResponseMapMetadata): proto.AIRichResponseMapMetadata;
    public static encode(m: proto.IAIRichResponseMapMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseMapMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseMapMetadata;
    public static toObject(m: proto.AIRichResponseMapMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace AIRichResponseMapMetadata {
    interface IAIRichResponseMapAnnotation {
      annotationNumber?: (number | null);
      latitude?: (number | null);
      longitude?: (number | null);
      title?: (string | null);
      body?: (string | null);
    }
    class AIRichResponseMapAnnotation implements IAIRichResponseMapAnnotation {
      constructor(p?: proto.AIRichResponseMapMetadata.IAIRichResponseMapAnnotation);
      public annotationNumber?: (number | null);
      public latitude?: (number | null);
      public longitude?: (number | null);
      public title?: (string | null);
      public body?: (string | null);
      public static create(properties?: proto.AIRichResponseMapMetadata.IAIRichResponseMapAnnotation): proto.AIRichResponseMapMetadata.AIRichResponseMapAnnotation;
      public static encode(m: proto.AIRichResponseMapMetadata.IAIRichResponseMapAnnotation, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseMapMetadata.AIRichResponseMapAnnotation;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.AIRichResponseMapMetadata.AIRichResponseMapAnnotation;
      public static toObject(m: proto.AIRichResponseMapMetadata.AIRichResponseMapAnnotation, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IAIRichResponseMessage {
    messageType?: (proto.AIRichResponseMessageType | null);
    submessages?: (proto.IAIRichResponseSubMessage[] | null);
    unifiedResponse?: (proto.IAIRichResponseUnifiedResponse | null);
    contextInfo?: (proto.IContextInfo | null);
  }
  class AIRichResponseMessage implements IAIRichResponseMessage {
    constructor(p?: proto.IAIRichResponseMessage);
    public messageType?: (proto.AIRichResponseMessageType | null);
    public submessages: proto.IAIRichResponseSubMessage[];
    public unifiedResponse?: (proto.IAIRichResponseUnifiedResponse | null);
    public contextInfo?: (proto.IContextInfo | null);
    public static create(properties?: proto.IAIRichResponseMessage): proto.AIRichResponseMessage;
    public static encode(m: proto.IAIRichResponseMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseMessage;
    public static toObject(m: proto.AIRichResponseMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  enum AIRichResponseMessageType {
    AI_RICH_RESPONSE_TYPE_UNKNOWN = 0,
    AI_RICH_RESPONSE_TYPE_STANDARD = 1
  }
  interface IAIRichResponseSubMessage {
    messageType?: (proto.AIRichResponseSubMessageType | null);
    gridImageMetadata?: (proto.IAIRichResponseGridImageMetadata | null);
    messageText?: (string | null);
    imageMetadata?: (proto.IAIRichResponseInlineImageMetadata | null);
    codeMetadata?: (proto.IAIRichResponseCodeMetadata | null);
    tableMetadata?: (proto.IAIRichResponseTableMetadata | null);
    dynamicMetadata?: (proto.IAIRichResponseDynamicMetadata | null);
    latexMetadata?: (proto.IAIRichResponseLatexMetadata | null);
    mapMetadata?: (proto.IAIRichResponseMapMetadata | null);
    contentItemsMetadata?: (proto.IAIRichResponseContentItemsMetadata | null);
  }
  class AIRichResponseSubMessage implements IAIRichResponseSubMessage {
    constructor(p?: proto.IAIRichResponseSubMessage);
    public messageType?: (proto.AIRichResponseSubMessageType | null);
    public gridImageMetadata?: (proto.IAIRichResponseGridImageMetadata | null);
    public messageText?: (string | null);
    public imageMetadata?: (proto.IAIRichResponseInlineImageMetadata | null);
    public codeMetadata?: (proto.IAIRichResponseCodeMetadata | null);
    public tableMetadata?: (proto.IAIRichResponseTableMetadata | null);
    public dynamicMetadata?: (proto.IAIRichResponseDynamicMetadata | null);
    public latexMetadata?: (proto.IAIRichResponseLatexMetadata | null);
    public mapMetadata?: (proto.IAIRichResponseMapMetadata | null);
    public contentItemsMetadata?: (proto.IAIRichResponseContentItemsMetadata | null);
    public static create(properties?: proto.IAIRichResponseSubMessage): proto.AIRichResponseSubMessage;
    public static encode(m: proto.IAIRichResponseSubMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseSubMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseSubMessage;
    public static toObject(m: proto.AIRichResponseSubMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  enum AIRichResponseSubMessageType {
    AI_RICH_RESPONSE_UNKNOWN = 0,
    AI_RICH_RESPONSE_GRID_IMAGE = 1,
    AI_RICH_RESPONSE_TEXT = 2,
    AI_RICH_RESPONSE_INLINE_IMAGE = 3,
    AI_RICH_RESPONSE_TABLE = 4,
    AI_RICH_RESPONSE_CODE = 5,
    AI_RICH_RESPONSE_DYNAMIC = 6,
    AI_RICH_RESPONSE_MAP = 7,
    AI_RICH_RESPONSE_LATEX = 8,
    AI_RICH_RESPONSE_CONTENT_ITEMS = 9
  }
  interface IAIRichResponseTableMetadata {
    rows?: (proto.AIRichResponseTableMetadata.IAIRichResponseTableRow[] | null);
    title?: (string | null);
  }
  class AIRichResponseTableMetadata implements IAIRichResponseTableMetadata {
    constructor(p?: proto.IAIRichResponseTableMetadata);
    public rows: proto.AIRichResponseTableMetadata.IAIRichResponseTableRow[];
    public title?: (string | null);
    public static create(properties?: proto.IAIRichResponseTableMetadata): proto.AIRichResponseTableMetadata;
    public static encode(m: proto.IAIRichResponseTableMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseTableMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseTableMetadata;
    public static toObject(m: proto.AIRichResponseTableMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace AIRichResponseTableMetadata {
    interface IAIRichResponseTableRow {
      items?: (string[] | null);
      isHeading?: (boolean | null);
    }
    class AIRichResponseTableRow implements IAIRichResponseTableRow {
      constructor(p?: proto.AIRichResponseTableMetadata.IAIRichResponseTableRow);
      public items: string[];
      public isHeading?: (boolean | null);
      public static create(properties?: proto.AIRichResponseTableMetadata.IAIRichResponseTableRow): proto.AIRichResponseTableMetadata.AIRichResponseTableRow;
      public static encode(m: proto.AIRichResponseTableMetadata.IAIRichResponseTableRow, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseTableMetadata.AIRichResponseTableRow;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.AIRichResponseTableMetadata.AIRichResponseTableRow;
      public static toObject(m: proto.AIRichResponseTableMetadata.AIRichResponseTableRow, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IAIRichResponseUnifiedResponse {
    data?: (Uint8Array | null);
  }
  class AIRichResponseUnifiedResponse implements IAIRichResponseUnifiedResponse {
    constructor(p?: proto.IAIRichResponseUnifiedResponse);
    public data?: (Uint8Array | null);
    public static create(properties?: proto.IAIRichResponseUnifiedResponse): proto.AIRichResponseUnifiedResponse;
    public static encode(m: proto.IAIRichResponseUnifiedResponse, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIRichResponseUnifiedResponse;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIRichResponseUnifiedResponse;
    public static toObject(m: proto.AIRichResponseUnifiedResponse, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IAIThreadInfo {
    serverInfo?: (proto.AIThreadInfo.IAIThreadServerInfo | null);
    clientInfo?: (proto.AIThreadInfo.IAIThreadClientInfo | null);
  }
  class AIThreadInfo implements IAIThreadInfo {
    constructor(p?: proto.IAIThreadInfo);
    public serverInfo?: (proto.AIThreadInfo.IAIThreadServerInfo | null);
    public clientInfo?: (proto.AIThreadInfo.IAIThreadClientInfo | null);
    public static create(properties?: proto.IAIThreadInfo): proto.AIThreadInfo;
    public static encode(m: proto.IAIThreadInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AIThreadInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AIThreadInfo;
    public static toObject(m: proto.AIThreadInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace AIThreadInfo {
    interface IAIThreadClientInfo {
      type?: (proto.AIThreadInfo.AIThreadClientInfo.AIThreadType | null);
    }
    class AIThreadClientInfo implements IAIThreadClientInfo {
      constructor(p?: proto.AIThreadInfo.IAIThreadClientInfo);
      public type?: (proto.AIThreadInfo.AIThreadClientInfo.AIThreadType | null);
      public static create(properties?: proto.AIThreadInfo.IAIThreadClientInfo): proto.AIThreadInfo.AIThreadClientInfo;
      public static encode(m: proto.AIThreadInfo.IAIThreadClientInfo, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.AIThreadInfo.AIThreadClientInfo;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.AIThreadInfo.AIThreadClientInfo;
      public static toObject(m: proto.AIThreadInfo.AIThreadClientInfo, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace AIThreadClientInfo {
      enum AIThreadType {
        UNKNOWN = 0,
        DEFAULT = 1,
        INCOGNITO = 2
      }
    }
    interface IAIThreadServerInfo {
      title?: (string | null);
    }
    class AIThreadServerInfo implements IAIThreadServerInfo {
      constructor(p?: proto.AIThreadInfo.IAIThreadServerInfo);
      public title?: (string | null);
      public static create(properties?: proto.AIThreadInfo.IAIThreadServerInfo): proto.AIThreadInfo.AIThreadServerInfo;
      public static encode(m: proto.AIThreadInfo.IAIThreadServerInfo, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.AIThreadInfo.AIThreadServerInfo;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.AIThreadInfo.AIThreadServerInfo;
      public static toObject(m: proto.AIThreadInfo.AIThreadServerInfo, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IAccount {
    lid?: (string | null);
    username?: (string | null);
    countryCode?: (string | null);
    isUsernameDeleted?: (boolean | null);
  }
  class Account implements IAccount {
    constructor(p?: proto.IAccount);
    public lid?: (string | null);
    public username?: (string | null);
    public countryCode?: (string | null);
    public isUsernameDeleted?: (boolean | null);
    public static create(properties?: proto.IAccount): proto.Account;
    public static encode(m: proto.IAccount, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Account;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Account;
    public static toObject(m: proto.Account, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IActionLink {
    url?: (string | null);
    buttonTitle?: (string | null);
  }
  class ActionLink implements IActionLink {
    constructor(p?: proto.IActionLink);
    public url?: (string | null);
    public buttonTitle?: (string | null);
    public static create(properties?: proto.IActionLink): proto.ActionLink;
    public static encode(m: proto.IActionLink, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ActionLink;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ActionLink;
    public static toObject(m: proto.ActionLink, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IAutoDownloadSettings {
    downloadImages?: (boolean | null);
    downloadAudio?: (boolean | null);
    downloadVideo?: (boolean | null);
    downloadDocuments?: (boolean | null);
  }
  class AutoDownloadSettings implements IAutoDownloadSettings {
    constructor(p?: proto.IAutoDownloadSettings);
    public downloadImages?: (boolean | null);
    public downloadAudio?: (boolean | null);
    public downloadVideo?: (boolean | null);
    public downloadDocuments?: (boolean | null);
    public static create(properties?: proto.IAutoDownloadSettings): proto.AutoDownloadSettings;
    public static encode(m: proto.IAutoDownloadSettings, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AutoDownloadSettings;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AutoDownloadSettings;
    public static toObject(m: proto.AutoDownloadSettings, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IAvatarUserSettings {
    fbid?: (string | null);
    password?: (string | null);
  }
  class AvatarUserSettings implements IAvatarUserSettings {
    constructor(p?: proto.IAvatarUserSettings);
    public fbid?: (string | null);
    public password?: (string | null);
    public static create(properties?: proto.IAvatarUserSettings): proto.AvatarUserSettings;
    public static encode(m: proto.IAvatarUserSettings, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.AvatarUserSettings;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.AvatarUserSettings;
    public static toObject(m: proto.AvatarUserSettings, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBizAccountLinkInfo {
    whatsappBizAcctFbid?: (number | Long$1 | null);
    whatsappAcctNumber?: (string | null);
    issueTime?: (number | Long$1 | null);
    hostStorage?: (proto.BizAccountLinkInfo.HostStorageType | null);
    accountType?: (proto.BizAccountLinkInfo.AccountType | null);
  }
  class BizAccountLinkInfo implements IBizAccountLinkInfo {
    constructor(p?: proto.IBizAccountLinkInfo);
    public whatsappBizAcctFbid?: (number | Long$1 | null);
    public whatsappAcctNumber?: (string | null);
    public issueTime?: (number | Long$1 | null);
    public hostStorage?: (proto.BizAccountLinkInfo.HostStorageType | null);
    public accountType?: (proto.BizAccountLinkInfo.AccountType | null);
    public static create(properties?: proto.IBizAccountLinkInfo): proto.BizAccountLinkInfo;
    public static encode(m: proto.IBizAccountLinkInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BizAccountLinkInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BizAccountLinkInfo;
    public static toObject(m: proto.BizAccountLinkInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BizAccountLinkInfo {
    enum AccountType {
      ENTERPRISE = 0
    }
    enum HostStorageType {
      ON_PREMISE = 0,
      FACEBOOK = 1
    }
  }
  interface IBizAccountPayload {
    vnameCert?: (proto.IVerifiedNameCertificate | null);
    bizAcctLinkInfo?: (Uint8Array | null);
  }
  class BizAccountPayload implements IBizAccountPayload {
    constructor(p?: proto.IBizAccountPayload);
    public vnameCert?: (proto.IVerifiedNameCertificate | null);
    public bizAcctLinkInfo?: (Uint8Array | null);
    public static create(properties?: proto.IBizAccountPayload): proto.BizAccountPayload;
    public static encode(m: proto.IBizAccountPayload, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BizAccountPayload;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BizAccountPayload;
    public static toObject(m: proto.BizAccountPayload, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBizIdentityInfo {
    vlevel?: (proto.BizIdentityInfo.VerifiedLevelValue | null);
    vnameCert?: (proto.IVerifiedNameCertificate | null);
    signed?: (boolean | null);
    revoked?: (boolean | null);
    hostStorage?: (proto.BizIdentityInfo.HostStorageType | null);
    actualActors?: (proto.BizIdentityInfo.ActualActorsType | null);
    privacyModeTs?: (number | Long$1 | null);
    featureControls?: (number | Long$1 | null);
  }
  class BizIdentityInfo implements IBizIdentityInfo {
    constructor(p?: proto.IBizIdentityInfo);
    public vlevel?: (proto.BizIdentityInfo.VerifiedLevelValue | null);
    public vnameCert?: (proto.IVerifiedNameCertificate | null);
    public signed?: (boolean | null);
    public revoked?: (boolean | null);
    public hostStorage?: (proto.BizIdentityInfo.HostStorageType | null);
    public actualActors?: (proto.BizIdentityInfo.ActualActorsType | null);
    public privacyModeTs?: (number | Long$1 | null);
    public featureControls?: (number | Long$1 | null);
    public static create(properties?: proto.IBizIdentityInfo): proto.BizIdentityInfo;
    public static encode(m: proto.IBizIdentityInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BizIdentityInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BizIdentityInfo;
    public static toObject(m: proto.BizIdentityInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BizIdentityInfo {
    enum ActualActorsType {
      SELF = 0,
      BSP = 1
    }
    enum HostStorageType {
      ON_PREMISE = 0,
      FACEBOOK = 1
    }
    enum VerifiedLevelValue {
      UNKNOWN = 0,
      LOW = 1,
      HIGH = 2
    }
  }
  interface IBotAgeCollectionMetadata {
    ageCollectionEligible?: (boolean | null);
    shouldTriggerAgeCollectionOnClient?: (boolean | null);
    ageCollectionType?: (proto.BotAgeCollectionMetadata.AgeCollectionType | null);
  }
  class BotAgeCollectionMetadata implements IBotAgeCollectionMetadata {
    constructor(p?: proto.IBotAgeCollectionMetadata);
    public ageCollectionEligible?: (boolean | null);
    public shouldTriggerAgeCollectionOnClient?: (boolean | null);
    public ageCollectionType?: (proto.BotAgeCollectionMetadata.AgeCollectionType | null);
    public static create(properties?: proto.IBotAgeCollectionMetadata): proto.BotAgeCollectionMetadata;
    public static encode(m: proto.IBotAgeCollectionMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotAgeCollectionMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotAgeCollectionMetadata;
    public static toObject(m: proto.BotAgeCollectionMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotAgeCollectionMetadata {
    enum AgeCollectionType {
      O18_BINARY = 0,
      WAFFLE = 1
    }
  }
  interface IBotAvatarMetadata {
    sentiment?: (number | null);
    behaviorGraph?: (string | null);
    action?: (number | null);
    intensity?: (number | null);
    wordCount?: (number | null);
  }
  class BotAvatarMetadata implements IBotAvatarMetadata {
    constructor(p?: proto.IBotAvatarMetadata);
    public sentiment?: (number | null);
    public behaviorGraph?: (string | null);
    public action?: (number | null);
    public intensity?: (number | null);
    public wordCount?: (number | null);
    public static create(properties?: proto.IBotAvatarMetadata): proto.BotAvatarMetadata;
    public static encode(m: proto.IBotAvatarMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotAvatarMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotAvatarMetadata;
    public static toObject(m: proto.BotAvatarMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBotCapabilityMetadata {
    capabilities?: (proto.BotCapabilityMetadata.BotCapabilityType[] | null);
  }
  class BotCapabilityMetadata implements IBotCapabilityMetadata {
    constructor(p?: proto.IBotCapabilityMetadata);
    public capabilities: proto.BotCapabilityMetadata.BotCapabilityType[];
    public static create(properties?: proto.IBotCapabilityMetadata): proto.BotCapabilityMetadata;
    public static encode(m: proto.IBotCapabilityMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotCapabilityMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotCapabilityMetadata;
    public static toObject(m: proto.BotCapabilityMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotCapabilityMetadata {
    enum BotCapabilityType {
      UNKNOWN = 0,
      PROGRESS_INDICATOR = 1,
      RICH_RESPONSE_HEADING = 2,
      RICH_RESPONSE_NESTED_LIST = 3,
      AI_MEMORY = 4,
      RICH_RESPONSE_THREAD_SURFING = 5,
      RICH_RESPONSE_TABLE = 6,
      RICH_RESPONSE_CODE = 7,
      RICH_RESPONSE_STRUCTURED_RESPONSE = 8,
      RICH_RESPONSE_INLINE_IMAGE = 9,
      WA_IG_1P_PLUGIN_RANKING_CONTROL = 10,
      WA_IG_1P_PLUGIN_RANKING_UPDATE_1 = 11,
      WA_IG_1P_PLUGIN_RANKING_UPDATE_2 = 12,
      WA_IG_1P_PLUGIN_RANKING_UPDATE_3 = 13,
      WA_IG_1P_PLUGIN_RANKING_UPDATE_4 = 14,
      WA_IG_1P_PLUGIN_RANKING_UPDATE_5 = 15,
      WA_IG_1P_PLUGIN_RANKING_UPDATE_6 = 16,
      WA_IG_1P_PLUGIN_RANKING_UPDATE_7 = 17,
      WA_IG_1P_PLUGIN_RANKING_UPDATE_8 = 18,
      WA_IG_1P_PLUGIN_RANKING_UPDATE_9 = 19,
      WA_IG_1P_PLUGIN_RANKING_UPDATE_10 = 20,
      RICH_RESPONSE_SUB_HEADING = 21,
      RICH_RESPONSE_GRID_IMAGE = 22,
      AI_STUDIO_UGC_MEMORY = 23,
      RICH_RESPONSE_LATEX = 24,
      RICH_RESPONSE_MAPS = 25,
      RICH_RESPONSE_INLINE_REELS = 26,
      AGENTIC_PLANNING = 27,
      ACCOUNT_LINKING = 28,
      STREAMING_DISAGGREGATION = 29,
      RICH_RESPONSE_GRID_IMAGE_3P = 30,
      RICH_RESPONSE_LATEX_INLINE = 31,
      QUERY_PLAN = 32,
      PROACTIVE_MESSAGE = 33,
      RICH_RESPONSE_UNIFIED_RESPONSE = 34,
      PROMOTION_MESSAGE = 35,
      SIMPLIFIED_PROFILE_PAGE = 36,
      RICH_RESPONSE_SOURCES_IN_MESSAGE = 37,
      RICH_RESPONSE_SIDE_BY_SIDE_SURVEY = 38,
      RICH_RESPONSE_UNIFIED_TEXT_COMPONENT = 39,
      AI_SHARED_MEMORY = 40,
      RICH_RESPONSE_UNIFIED_SOURCES = 41,
      RICH_RESPONSE_UNIFIED_DOMAIN_CITATIONS = 42,
      RICH_RESPONSE_UR_INLINE_REELS_ENABLED = 43,
      RICH_RESPONSE_UR_MEDIA_GRID_ENABLED = 44,
      RICH_RESPONSE_UR_TIMESTAMP_PLACEHOLDER = 45,
      RICH_RESPONSE_IN_APP_SURVEY = 46,
      AI_RESPONSE_MODEL_BRANDING = 47,
      SESSION_TRANSPARENCY_SYSTEM_MESSAGE = 48,
      RICH_RESPONSE_UR_REASONING = 49
    }
  }
  interface IBotFeedbackMessage {
    messageKey?: (proto.IMessageKey | null);
    kind?: (proto.BotFeedbackMessage.BotFeedbackKind | null);
    text?: (string | null);
    kindNegative?: (number | Long$1 | null);
    kindPositive?: (number | Long$1 | null);
    kindReport?: (proto.BotFeedbackMessage.ReportKind | null);
    sideBySideSurveyMetadata?: (proto.BotFeedbackMessage.ISideBySideSurveyMetadata | null);
  }
  class BotFeedbackMessage implements IBotFeedbackMessage {
    constructor(p?: proto.IBotFeedbackMessage);
    public messageKey?: (proto.IMessageKey | null);
    public kind?: (proto.BotFeedbackMessage.BotFeedbackKind | null);
    public text?: (string | null);
    public kindNegative?: (number | Long$1 | null);
    public kindPositive?: (number | Long$1 | null);
    public kindReport?: (proto.BotFeedbackMessage.ReportKind | null);
    public sideBySideSurveyMetadata?: (proto.BotFeedbackMessage.ISideBySideSurveyMetadata | null);
    public static create(properties?: proto.IBotFeedbackMessage): proto.BotFeedbackMessage;
    public static encode(m: proto.IBotFeedbackMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotFeedbackMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotFeedbackMessage;
    public static toObject(m: proto.BotFeedbackMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotFeedbackMessage {
    enum BotFeedbackKind {
      BOT_FEEDBACK_POSITIVE = 0,
      BOT_FEEDBACK_NEGATIVE_GENERIC = 1,
      BOT_FEEDBACK_NEGATIVE_HELPFUL = 2,
      BOT_FEEDBACK_NEGATIVE_INTERESTING = 3,
      BOT_FEEDBACK_NEGATIVE_ACCURATE = 4,
      BOT_FEEDBACK_NEGATIVE_SAFE = 5,
      BOT_FEEDBACK_NEGATIVE_OTHER = 6,
      BOT_FEEDBACK_NEGATIVE_REFUSED = 7,
      BOT_FEEDBACK_NEGATIVE_NOT_VISUALLY_APPEALING = 8,
      BOT_FEEDBACK_NEGATIVE_NOT_RELEVANT_TO_TEXT = 9,
      BOT_FEEDBACK_NEGATIVE_PERSONALIZED = 10,
      BOT_FEEDBACK_NEGATIVE_CLARITY = 11,
      BOT_FEEDBACK_NEGATIVE_DOESNT_LOOK_LIKE_THE_PERSON = 12,
      BOT_FEEDBACK_NEGATIVE_HALLUCINATION_INTERNAL_ONLY = 13,
      BOT_FEEDBACK_NEGATIVE = 14
    }
    enum BotFeedbackKindMultipleNegative {
      BOT_FEEDBACK_MULTIPLE_NEGATIVE_GENERIC = 1,
      BOT_FEEDBACK_MULTIPLE_NEGATIVE_HELPFUL = 2,
      BOT_FEEDBACK_MULTIPLE_NEGATIVE_INTERESTING = 4,
      BOT_FEEDBACK_MULTIPLE_NEGATIVE_ACCURATE = 8,
      BOT_FEEDBACK_MULTIPLE_NEGATIVE_SAFE = 16,
      BOT_FEEDBACK_MULTIPLE_NEGATIVE_OTHER = 32,
      BOT_FEEDBACK_MULTIPLE_NEGATIVE_REFUSED = 64,
      BOT_FEEDBACK_MULTIPLE_NEGATIVE_NOT_VISUALLY_APPEALING = 128,
      BOT_FEEDBACK_MULTIPLE_NEGATIVE_NOT_RELEVANT_TO_TEXT = 256
    }
    enum BotFeedbackKindMultiplePositive {
      BOT_FEEDBACK_MULTIPLE_POSITIVE_GENERIC = 1
    }
    enum ReportKind {
      NONE = 0,
      GENERIC = 1
    }
    interface ISideBySideSurveyMetadata {
      selectedRequestId?: (string | null);
      surveyId?: (number | null);
      simonSessionFbid?: (string | null);
      responseOtid?: (string | null);
      responseTimestampMsString?: (string | null);
      isSelectedResponsePrimary?: (boolean | null);
      messageIdToEdit?: (string | null);
      analyticsData?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.ISideBySideSurveyAnalyticsData | null);
      metaAiAnalyticsData?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.ISidebySideSurveyMetaAiAnalyticsData | null);
    }
    class SideBySideSurveyMetadata implements ISideBySideSurveyMetadata {
      constructor(p?: proto.BotFeedbackMessage.ISideBySideSurveyMetadata);
      public selectedRequestId?: (string | null);
      public surveyId?: (number | null);
      public simonSessionFbid?: (string | null);
      public responseOtid?: (string | null);
      public responseTimestampMsString?: (string | null);
      public isSelectedResponsePrimary?: (boolean | null);
      public messageIdToEdit?: (string | null);
      public analyticsData?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.ISideBySideSurveyAnalyticsData | null);
      public metaAiAnalyticsData?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.ISidebySideSurveyMetaAiAnalyticsData | null);
      public static create(properties?: proto.BotFeedbackMessage.ISideBySideSurveyMetadata): proto.BotFeedbackMessage.SideBySideSurveyMetadata;
      public static encode(m: proto.BotFeedbackMessage.ISideBySideSurveyMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.BotFeedbackMessage.SideBySideSurveyMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.BotFeedbackMessage.SideBySideSurveyMetadata;
      public static toObject(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace SideBySideSurveyMetadata {
      interface ISideBySideSurveyAnalyticsData {
        tessaEvent?: (string | null);
        tessaSessionFbid?: (string | null);
        simonSessionFbid?: (string | null);
      }
      class SideBySideSurveyAnalyticsData implements ISideBySideSurveyAnalyticsData {
        constructor(p?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.ISideBySideSurveyAnalyticsData);
        public tessaEvent?: (string | null);
        public tessaSessionFbid?: (string | null);
        public simonSessionFbid?: (string | null);
        public static create(properties?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.ISideBySideSurveyAnalyticsData): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SideBySideSurveyAnalyticsData;
        public static encode(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.ISideBySideSurveyAnalyticsData, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SideBySideSurveyAnalyticsData;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SideBySideSurveyAnalyticsData;
        public static toObject(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SideBySideSurveyAnalyticsData, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface ISidebySideSurveyMetaAiAnalyticsData {
        surveyId?: (number | null);
        primaryResponseId?: (string | null);
        testArmName?: (string | null);
        timestampMsString?: (string | null);
        ctaImpressionEvent?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCTAImpressionEventData | null);
        ctaClickEvent?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCTAClickEventData | null);
        cardImpressionEvent?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCardImpressionEventData | null);
        responseEvent?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyResponseEventData | null);
        abandonEvent?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyAbandonEventData | null);
      }
      class SidebySideSurveyMetaAiAnalyticsData implements ISidebySideSurveyMetaAiAnalyticsData {
        constructor(p?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.ISidebySideSurveyMetaAiAnalyticsData);
        public surveyId?: (number | null);
        public primaryResponseId?: (string | null);
        public testArmName?: (string | null);
        public timestampMsString?: (string | null);
        public ctaImpressionEvent?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCTAImpressionEventData | null);
        public ctaClickEvent?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCTAClickEventData | null);
        public cardImpressionEvent?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCardImpressionEventData | null);
        public responseEvent?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyResponseEventData | null);
        public abandonEvent?: (proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyAbandonEventData | null);
        public static create(properties?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.ISidebySideSurveyMetaAiAnalyticsData): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData;
        public static encode(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.ISidebySideSurveyMetaAiAnalyticsData, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData;
        public static toObject(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace SidebySideSurveyMetaAiAnalyticsData {
        interface ISideBySideSurveyAbandonEventData {
          abandonDwellTimeMsString?: (string | null);
        }
        class SideBySideSurveyAbandonEventData implements ISideBySideSurveyAbandonEventData {
          constructor(p?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyAbandonEventData);
          public abandonDwellTimeMsString?: (string | null);
          public static create(properties?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyAbandonEventData): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyAbandonEventData;
          public static encode(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyAbandonEventData, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyAbandonEventData;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyAbandonEventData;
          public static toObject(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyAbandonEventData, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        interface ISideBySideSurveyCTAClickEventData {
          isSurveyExpired?: (boolean | null);
          clickDwellTimeMsString?: (string | null);
        }
        class SideBySideSurveyCTAClickEventData implements ISideBySideSurveyCTAClickEventData {
          constructor(p?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCTAClickEventData);
          public isSurveyExpired?: (boolean | null);
          public clickDwellTimeMsString?: (string | null);
          public static create(properties?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCTAClickEventData): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCTAClickEventData;
          public static encode(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCTAClickEventData, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCTAClickEventData;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCTAClickEventData;
          public static toObject(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCTAClickEventData, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        interface ISideBySideSurveyCTAImpressionEventData {
          isSurveyExpired?: (boolean | null);
        }
        class SideBySideSurveyCTAImpressionEventData implements ISideBySideSurveyCTAImpressionEventData {
          constructor(p?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCTAImpressionEventData);
          public isSurveyExpired?: (boolean | null);
          public static create(properties?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCTAImpressionEventData): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCTAImpressionEventData;
          public static encode(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCTAImpressionEventData, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCTAImpressionEventData;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCTAImpressionEventData;
          public static toObject(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCTAImpressionEventData, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        interface ISideBySideSurveyCardImpressionEventData {}
        class SideBySideSurveyCardImpressionEventData implements ISideBySideSurveyCardImpressionEventData {
          constructor(p?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCardImpressionEventData);
          public static create(properties?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCardImpressionEventData): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCardImpressionEventData;
          public static encode(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyCardImpressionEventData, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCardImpressionEventData;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCardImpressionEventData;
          public static toObject(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyCardImpressionEventData, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        interface ISideBySideSurveyResponseEventData {
          responseDwellTimeMsString?: (string | null);
          selectedResponseId?: (string | null);
        }
        class SideBySideSurveyResponseEventData implements ISideBySideSurveyResponseEventData {
          constructor(p?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyResponseEventData);
          public responseDwellTimeMsString?: (string | null);
          public selectedResponseId?: (string | null);
          public static create(properties?: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyResponseEventData): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyResponseEventData;
          public static encode(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.ISideBySideSurveyResponseEventData, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyResponseEventData;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyResponseEventData;
          public static toObject(m: proto.BotFeedbackMessage.SideBySideSurveyMetadata.SidebySideSurveyMetaAiAnalyticsData.SideBySideSurveyResponseEventData, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
      }
    }
  }
  interface IBotImagineMetadata {
    imagineType?: (proto.BotImagineMetadata.ImagineType | null);
  }
  class BotImagineMetadata implements IBotImagineMetadata {
    constructor(p?: proto.IBotImagineMetadata);
    public imagineType?: (proto.BotImagineMetadata.ImagineType | null);
    public static create(properties?: proto.IBotImagineMetadata): proto.BotImagineMetadata;
    public static encode(m: proto.IBotImagineMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotImagineMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotImagineMetadata;
    public static toObject(m: proto.BotImagineMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotImagineMetadata {
    enum ImagineType {
      UNKNOWN = 0,
      IMAGINE = 1,
      MEMU = 2,
      FLASH = 3,
      EDIT = 4
    }
  }
  interface IBotLinkedAccount {
    type?: (proto.BotLinkedAccount.BotLinkedAccountType | null);
  }
  class BotLinkedAccount implements IBotLinkedAccount {
    constructor(p?: proto.IBotLinkedAccount);
    public type?: (proto.BotLinkedAccount.BotLinkedAccountType | null);
    public static create(properties?: proto.IBotLinkedAccount): proto.BotLinkedAccount;
    public static encode(m: proto.IBotLinkedAccount, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotLinkedAccount;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotLinkedAccount;
    public static toObject(m: proto.BotLinkedAccount, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotLinkedAccount {
    enum BotLinkedAccountType {
      BOT_LINKED_ACCOUNT_TYPE_1P = 0
    }
  }
  interface IBotLinkedAccountsMetadata {
    accounts?: (proto.IBotLinkedAccount[] | null);
    acAuthTokens?: (Uint8Array | null);
    acErrorCode?: (number | null);
  }
  class BotLinkedAccountsMetadata implements IBotLinkedAccountsMetadata {
    constructor(p?: proto.IBotLinkedAccountsMetadata);
    public accounts: proto.IBotLinkedAccount[];
    public acAuthTokens?: (Uint8Array | null);
    public acErrorCode?: (number | null);
    public static create(properties?: proto.IBotLinkedAccountsMetadata): proto.BotLinkedAccountsMetadata;
    public static encode(m: proto.IBotLinkedAccountsMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotLinkedAccountsMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotLinkedAccountsMetadata;
    public static toObject(m: proto.BotLinkedAccountsMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBotMediaMetadata {
    fileSha256?: (string | null);
    mediaKey?: (string | null);
    fileEncSha256?: (string | null);
    directPath?: (string | null);
    mediaKeyTimestamp?: (number | Long$1 | null);
    mimetype?: (string | null);
    orientationType?: (proto.BotMediaMetadata.OrientationType | null);
  }
  class BotMediaMetadata implements IBotMediaMetadata {
    constructor(p?: proto.IBotMediaMetadata);
    public fileSha256?: (string | null);
    public mediaKey?: (string | null);
    public fileEncSha256?: (string | null);
    public directPath?: (string | null);
    public mediaKeyTimestamp?: (number | Long$1 | null);
    public mimetype?: (string | null);
    public orientationType?: (proto.BotMediaMetadata.OrientationType | null);
    public static create(properties?: proto.IBotMediaMetadata): proto.BotMediaMetadata;
    public static encode(m: proto.IBotMediaMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotMediaMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotMediaMetadata;
    public static toObject(m: proto.BotMediaMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotMediaMetadata {
    enum OrientationType {
      CENTER = 1,
      LEFT = 2,
      RIGHT = 3
    }
  }
  interface IBotMemoryFact {
    fact?: (string | null);
    factId?: (string | null);
  }
  class BotMemoryFact implements IBotMemoryFact {
    constructor(p?: proto.IBotMemoryFact);
    public fact?: (string | null);
    public factId?: (string | null);
    public static create(properties?: proto.IBotMemoryFact): proto.BotMemoryFact;
    public static encode(m: proto.IBotMemoryFact, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotMemoryFact;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotMemoryFact;
    public static toObject(m: proto.BotMemoryFact, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBotMemoryMetadata {
    addedFacts?: (proto.IBotMemoryFact[] | null);
    removedFacts?: (proto.IBotMemoryFact[] | null);
    disclaimer?: (string | null);
  }
  class BotMemoryMetadata implements IBotMemoryMetadata {
    constructor(p?: proto.IBotMemoryMetadata);
    public addedFacts: proto.IBotMemoryFact[];
    public removedFacts: proto.IBotMemoryFact[];
    public disclaimer?: (string | null);
    public static create(properties?: proto.IBotMemoryMetadata): proto.BotMemoryMetadata;
    public static encode(m: proto.IBotMemoryMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotMemoryMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotMemoryMetadata;
    public static toObject(m: proto.BotMemoryMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBotMemuMetadata {
    faceImages?: (proto.IBotMediaMetadata[] | null);
  }
  class BotMemuMetadata implements IBotMemuMetadata {
    constructor(p?: proto.IBotMemuMetadata);
    public faceImages: proto.IBotMediaMetadata[];
    public static create(properties?: proto.IBotMemuMetadata): proto.BotMemuMetadata;
    public static encode(m: proto.IBotMemuMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotMemuMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotMemuMetadata;
    public static toObject(m: proto.BotMemuMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBotMessageOrigin {
    type?: (proto.BotMessageOrigin.BotMessageOriginType | null);
  }
  class BotMessageOrigin implements IBotMessageOrigin {
    constructor(p?: proto.IBotMessageOrigin);
    public type?: (proto.BotMessageOrigin.BotMessageOriginType | null);
    public static create(properties?: proto.IBotMessageOrigin): proto.BotMessageOrigin;
    public static encode(m: proto.IBotMessageOrigin, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotMessageOrigin;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotMessageOrigin;
    public static toObject(m: proto.BotMessageOrigin, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotMessageOrigin {
    enum BotMessageOriginType {
      BOT_MESSAGE_ORIGIN_TYPE_AI_INITIATED = 0
    }
  }
  interface IBotMessageOriginMetadata {
    origins?: (proto.IBotMessageOrigin[] | null);
  }
  class BotMessageOriginMetadata implements IBotMessageOriginMetadata {
    constructor(p?: proto.IBotMessageOriginMetadata);
    public origins: proto.IBotMessageOrigin[];
    public static create(properties?: proto.IBotMessageOriginMetadata): proto.BotMessageOriginMetadata;
    public static encode(m: proto.IBotMessageOriginMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotMessageOriginMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotMessageOriginMetadata;
    public static toObject(m: proto.BotMessageOriginMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBotMessageSharingInfo {
    botEntryPointOrigin?: (proto.BotMetricsEntryPoint | null);
    forwardScore?: (number | null);
  }
  class BotMessageSharingInfo implements IBotMessageSharingInfo {
    constructor(p?: proto.IBotMessageSharingInfo);
    public botEntryPointOrigin?: (proto.BotMetricsEntryPoint | null);
    public forwardScore?: (number | null);
    public static create(properties?: proto.IBotMessageSharingInfo): proto.BotMessageSharingInfo;
    public static encode(m: proto.IBotMessageSharingInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotMessageSharingInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotMessageSharingInfo;
    public static toObject(m: proto.BotMessageSharingInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBotMetadata {
    avatarMetadata?: (proto.IBotAvatarMetadata | null);
    personaId?: (string | null);
    pluginMetadata?: (proto.IBotPluginMetadata | null);
    suggestedPromptMetadata?: (proto.IBotSuggestedPromptMetadata | null);
    invokerJid?: (string | null);
    sessionMetadata?: (proto.IBotSessionMetadata | null);
    memuMetadata?: (proto.IBotMemuMetadata | null);
    timezone?: (string | null);
    reminderMetadata?: (proto.IBotReminderMetadata | null);
    modelMetadata?: (proto.IBotModelMetadata | null);
    messageDisclaimerText?: (string | null);
    progressIndicatorMetadata?: (proto.IBotProgressIndicatorMetadata | null);
    capabilityMetadata?: (proto.IBotCapabilityMetadata | null);
    imagineMetadata?: (proto.IBotImagineMetadata | null);
    memoryMetadata?: (proto.IBotMemoryMetadata | null);
    renderingMetadata?: (proto.IBotRenderingMetadata | null);
    botMetricsMetadata?: (proto.IBotMetricsMetadata | null);
    botLinkedAccountsMetadata?: (proto.IBotLinkedAccountsMetadata | null);
    richResponseSourcesMetadata?: (proto.IBotSourcesMetadata | null);
    aiConversationContext?: (Uint8Array | null);
    botPromotionMessageMetadata?: (proto.IBotPromotionMessageMetadata | null);
    botModeSelectionMetadata?: (proto.IBotModeSelectionMetadata | null);
    botQuotaMetadata?: (proto.IBotQuotaMetadata | null);
    botAgeCollectionMetadata?: (proto.IBotAgeCollectionMetadata | null);
    conversationStarterPromptId?: (string | null);
    botResponseId?: (string | null);
    verificationMetadata?: (proto.IBotSignatureVerificationMetadata | null);
    unifiedResponseMutation?: (proto.IBotUnifiedResponseMutation | null);
    botMessageOriginMetadata?: (proto.IBotMessageOriginMetadata | null);
    inThreadSurveyMetadata?: (proto.IInThreadSurveyMetadata | null);
    botThreadInfo?: (proto.IAIThreadInfo | null);
    regenerateMetadata?: (proto.IAIRegenerateMetadata | null);
    sessionTransparencyMetadata?: (proto.ISessionTransparencyMetadata | null);
    internalMetadata?: (Uint8Array | null);
  }
  class BotMetadata implements IBotMetadata {
    constructor(p?: proto.IBotMetadata);
    public avatarMetadata?: (proto.IBotAvatarMetadata | null);
    public personaId?: (string | null);
    public pluginMetadata?: (proto.IBotPluginMetadata | null);
    public suggestedPromptMetadata?: (proto.IBotSuggestedPromptMetadata | null);
    public invokerJid?: (string | null);
    public sessionMetadata?: (proto.IBotSessionMetadata | null);
    public memuMetadata?: (proto.IBotMemuMetadata | null);
    public timezone?: (string | null);
    public reminderMetadata?: (proto.IBotReminderMetadata | null);
    public modelMetadata?: (proto.IBotModelMetadata | null);
    public messageDisclaimerText?: (string | null);
    public progressIndicatorMetadata?: (proto.IBotProgressIndicatorMetadata | null);
    public capabilityMetadata?: (proto.IBotCapabilityMetadata | null);
    public imagineMetadata?: (proto.IBotImagineMetadata | null);
    public memoryMetadata?: (proto.IBotMemoryMetadata | null);
    public renderingMetadata?: (proto.IBotRenderingMetadata | null);
    public botMetricsMetadata?: (proto.IBotMetricsMetadata | null);
    public botLinkedAccountsMetadata?: (proto.IBotLinkedAccountsMetadata | null);
    public richResponseSourcesMetadata?: (proto.IBotSourcesMetadata | null);
    public aiConversationContext?: (Uint8Array | null);
    public botPromotionMessageMetadata?: (proto.IBotPromotionMessageMetadata | null);
    public botModeSelectionMetadata?: (proto.IBotModeSelectionMetadata | null);
    public botQuotaMetadata?: (proto.IBotQuotaMetadata | null);
    public botAgeCollectionMetadata?: (proto.IBotAgeCollectionMetadata | null);
    public conversationStarterPromptId?: (string | null);
    public botResponseId?: (string | null);
    public verificationMetadata?: (proto.IBotSignatureVerificationMetadata | null);
    public unifiedResponseMutation?: (proto.IBotUnifiedResponseMutation | null);
    public botMessageOriginMetadata?: (proto.IBotMessageOriginMetadata | null);
    public inThreadSurveyMetadata?: (proto.IInThreadSurveyMetadata | null);
    public botThreadInfo?: (proto.IAIThreadInfo | null);
    public regenerateMetadata?: (proto.IAIRegenerateMetadata | null);
    public sessionTransparencyMetadata?: (proto.ISessionTransparencyMetadata | null);
    public internalMetadata?: (Uint8Array | null);
    public static create(properties?: proto.IBotMetadata): proto.BotMetadata;
    public static encode(m: proto.IBotMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotMetadata;
    public static toObject(m: proto.BotMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  enum BotMetricsEntryPoint {
    UNDEFINED_ENTRY_POINT = 0,
    FAVICON = 1,
    CHATLIST = 2,
    AISEARCH_NULL_STATE_PAPER_PLANE = 3,
    AISEARCH_NULL_STATE_SUGGESTION = 4,
    AISEARCH_TYPE_AHEAD_SUGGESTION = 5,
    AISEARCH_TYPE_AHEAD_PAPER_PLANE = 6,
    AISEARCH_TYPE_AHEAD_RESULT_CHATLIST = 7,
    AISEARCH_TYPE_AHEAD_RESULT_MESSAGES = 8,
    AIVOICE_SEARCH_BAR = 9,
    AIVOICE_FAVICON = 10,
    AISTUDIO = 11,
    DEEPLINK = 12,
    NOTIFICATION = 13,
    PROFILE_MESSAGE_BUTTON = 14,
    FORWARD = 15,
    APP_SHORTCUT = 16,
    FF_FAMILY = 17,
    AI_TAB = 18,
    AI_HOME = 19,
    AI_DEEPLINK_IMMERSIVE = 20,
    AI_DEEPLINK = 21,
    META_AI_CHAT_SHORTCUT_AI_STUDIO = 22,
    UGC_CHAT_SHORTCUT_AI_STUDIO = 23,
    NEW_CHAT_AI_STUDIO = 24,
    AIVOICE_FAVICON_CALL_HISTORY = 25,
    ASK_META_AI_CONTEXT_MENU = 26,
    ASK_META_AI_CONTEXT_MENU_1ON1 = 27,
    ASK_META_AI_CONTEXT_MENU_GROUP = 28,
    INVOKE_META_AI_1ON1 = 29,
    INVOKE_META_AI_GROUP = 30,
    META_AI_FORWARD = 31,
    NEW_CHAT_AI_CONTACT = 32,
    MESSAGE_QUICK_ACTION_1_ON_1_CHAT = 33,
    MESSAGE_QUICK_ACTION_GROUP_CHAT = 34,
    ATTACHMENT_TRAY_1_ON_1_CHAT = 35,
    ATTACHMENT_TRAY_GROUP_CHAT = 36,
    ASK_META_AI_MEDIA_VIEWER_1ON1 = 37,
    ASK_META_AI_MEDIA_VIEWER_GROUP = 38
  }
  interface IBotMetricsMetadata {
    destinationId?: (string | null);
    destinationEntryPoint?: (proto.BotMetricsEntryPoint | null);
    threadOrigin?: (proto.BotMetricsThreadEntryPoint | null);
  }
  class BotMetricsMetadata implements IBotMetricsMetadata {
    constructor(p?: proto.IBotMetricsMetadata);
    public destinationId?: (string | null);
    public destinationEntryPoint?: (proto.BotMetricsEntryPoint | null);
    public threadOrigin?: (proto.BotMetricsThreadEntryPoint | null);
    public static create(properties?: proto.IBotMetricsMetadata): proto.BotMetricsMetadata;
    public static encode(m: proto.IBotMetricsMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotMetricsMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotMetricsMetadata;
    public static toObject(m: proto.BotMetricsMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  enum BotMetricsThreadEntryPoint {
    AI_TAB_THREAD = 1,
    AI_HOME_THREAD = 2,
    AI_DEEPLINK_IMMERSIVE_THREAD = 3,
    AI_DEEPLINK_THREAD = 4,
    ASK_META_AI_CONTEXT_MENU_THREAD = 5
  }
  interface IBotModeSelectionMetadata {
    mode?: (proto.BotModeSelectionMetadata.BotUserSelectionMode[] | null);
  }
  class BotModeSelectionMetadata implements IBotModeSelectionMetadata {
    constructor(p?: proto.IBotModeSelectionMetadata);
    public mode: proto.BotModeSelectionMetadata.BotUserSelectionMode[];
    public static create(properties?: proto.IBotModeSelectionMetadata): proto.BotModeSelectionMetadata;
    public static encode(m: proto.IBotModeSelectionMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotModeSelectionMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotModeSelectionMetadata;
    public static toObject(m: proto.BotModeSelectionMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotModeSelectionMetadata {
    enum BotUserSelectionMode {
      UNKNOWN_MODE = 0,
      REASONING_MODE = 1
    }
  }
  interface IBotModelMetadata {
    modelType?: (proto.BotModelMetadata.ModelType | null);
    premiumModelStatus?: (proto.BotModelMetadata.PremiumModelStatus | null);
    modelNameOverride?: (string | null);
  }
  class BotModelMetadata implements IBotModelMetadata {
    constructor(p?: proto.IBotModelMetadata);
    public modelType?: (proto.BotModelMetadata.ModelType | null);
    public premiumModelStatus?: (proto.BotModelMetadata.PremiumModelStatus | null);
    public modelNameOverride?: (string | null);
    public static create(properties?: proto.IBotModelMetadata): proto.BotModelMetadata;
    public static encode(m: proto.IBotModelMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotModelMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotModelMetadata;
    public static toObject(m: proto.BotModelMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotModelMetadata {
    enum ModelType {
      UNKNOWN_TYPE = 0,
      LLAMA_PROD = 1,
      LLAMA_PROD_PREMIUM = 2
    }
    enum PremiumModelStatus {
      UNKNOWN_STATUS = 0,
      AVAILABLE = 1,
      QUOTA_EXCEED_LIMIT = 2
    }
  }
  interface IBotPluginMetadata {
    provider?: (proto.BotPluginMetadata.SearchProvider | null);
    pluginType?: (proto.BotPluginMetadata.PluginType | null);
    thumbnailCdnUrl?: (string | null);
    profilePhotoCdnUrl?: (string | null);
    searchProviderUrl?: (string | null);
    referenceIndex?: (number | null);
    expectedLinksCount?: (number | null);
    searchQuery?: (string | null);
    parentPluginMessageKey?: (proto.IMessageKey | null);
    deprecatedField?: (proto.BotPluginMetadata.PluginType | null);
    parentPluginType?: (proto.BotPluginMetadata.PluginType | null);
    faviconCdnUrl?: (string | null);
  }
  class BotPluginMetadata implements IBotPluginMetadata {
    constructor(p?: proto.IBotPluginMetadata);
    public provider?: (proto.BotPluginMetadata.SearchProvider | null);
    public pluginType?: (proto.BotPluginMetadata.PluginType | null);
    public thumbnailCdnUrl?: (string | null);
    public profilePhotoCdnUrl?: (string | null);
    public searchProviderUrl?: (string | null);
    public referenceIndex?: (number | null);
    public expectedLinksCount?: (number | null);
    public searchQuery?: (string | null);
    public parentPluginMessageKey?: (proto.IMessageKey | null);
    public deprecatedField?: (proto.BotPluginMetadata.PluginType | null);
    public parentPluginType?: (proto.BotPluginMetadata.PluginType | null);
    public faviconCdnUrl?: (string | null);
    public static create(properties?: proto.IBotPluginMetadata): proto.BotPluginMetadata;
    public static encode(m: proto.IBotPluginMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotPluginMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotPluginMetadata;
    public static toObject(m: proto.BotPluginMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotPluginMetadata {
    enum PluginType {
      UNKNOWN_PLUGIN = 0,
      REELS = 1,
      SEARCH = 2
    }
    enum SearchProvider {
      UNKNOWN = 0,
      BING = 1,
      GOOGLE = 2,
      SUPPORT = 3
    }
  }
  interface IBotProgressIndicatorMetadata {
    progressDescription?: (string | null);
    stepsMetadata?: (proto.BotProgressIndicatorMetadata.IBotPlanningStepMetadata[] | null);
  }
  class BotProgressIndicatorMetadata implements IBotProgressIndicatorMetadata {
    constructor(p?: proto.IBotProgressIndicatorMetadata);
    public progressDescription?: (string | null);
    public stepsMetadata: proto.BotProgressIndicatorMetadata.IBotPlanningStepMetadata[];
    public static create(properties?: proto.IBotProgressIndicatorMetadata): proto.BotProgressIndicatorMetadata;
    public static encode(m: proto.IBotProgressIndicatorMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotProgressIndicatorMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotProgressIndicatorMetadata;
    public static toObject(m: proto.BotProgressIndicatorMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotProgressIndicatorMetadata {
    interface IBotPlanningStepMetadata {
      statusTitle?: (string | null);
      statusBody?: (string | null);
      sourcesMetadata?: (proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningSearchSourcesMetadata[] | null);
      status?: (proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.PlanningStepStatus | null);
      isReasoning?: (boolean | null);
      isEnhancedSearch?: (boolean | null);
      sections?: (proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningStepSectionMetadata[] | null);
    }
    class BotPlanningStepMetadata implements IBotPlanningStepMetadata {
      constructor(p?: proto.BotProgressIndicatorMetadata.IBotPlanningStepMetadata);
      public statusTitle?: (string | null);
      public statusBody?: (string | null);
      public sourcesMetadata: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningSearchSourcesMetadata[];
      public status?: (proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.PlanningStepStatus | null);
      public isReasoning?: (boolean | null);
      public isEnhancedSearch?: (boolean | null);
      public sections: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningStepSectionMetadata[];
      public static create(properties?: proto.BotProgressIndicatorMetadata.IBotPlanningStepMetadata): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata;
      public static encode(m: proto.BotProgressIndicatorMetadata.IBotPlanningStepMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata;
      public static toObject(m: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace BotPlanningStepMetadata {
      interface IBotPlanningSearchSourceMetadata {
        title?: (string | null);
        provider?: (proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotSearchSourceProvider | null);
        sourceUrl?: (string | null);
        favIconUrl?: (string | null);
      }
      class BotPlanningSearchSourceMetadata implements IBotPlanningSearchSourceMetadata {
        constructor(p?: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningSearchSourceMetadata);
        public title?: (string | null);
        public provider?: (proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotSearchSourceProvider | null);
        public sourceUrl?: (string | null);
        public favIconUrl?: (string | null);
        public static create(properties?: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningSearchSourceMetadata): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningSearchSourceMetadata;
        public static encode(m: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningSearchSourceMetadata, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningSearchSourceMetadata;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningSearchSourceMetadata;
        public static toObject(m: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningSearchSourceMetadata, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IBotPlanningSearchSourcesMetadata {
        sourceTitle?: (string | null);
        provider?: (proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningSearchSourcesMetadata.BotPlanningSearchSourceProvider | null);
        sourceUrl?: (string | null);
      }
      class BotPlanningSearchSourcesMetadata implements IBotPlanningSearchSourcesMetadata {
        constructor(p?: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningSearchSourcesMetadata);
        public sourceTitle?: (string | null);
        public provider?: (proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningSearchSourcesMetadata.BotPlanningSearchSourceProvider | null);
        public sourceUrl?: (string | null);
        public static create(properties?: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningSearchSourcesMetadata): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningSearchSourcesMetadata;
        public static encode(m: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningSearchSourcesMetadata, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningSearchSourcesMetadata;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningSearchSourcesMetadata;
        public static toObject(m: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningSearchSourcesMetadata, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace BotPlanningSearchSourcesMetadata {
        enum BotPlanningSearchSourceProvider {
          UNKNOWN = 0,
          OTHER = 1,
          GOOGLE = 2,
          BING = 3
        }
      }
      interface IBotPlanningStepSectionMetadata {
        sectionTitle?: (string | null);
        sectionBody?: (string | null);
        sourcesMetadata?: (proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningSearchSourceMetadata[] | null);
      }
      class BotPlanningStepSectionMetadata implements IBotPlanningStepSectionMetadata {
        constructor(p?: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningStepSectionMetadata);
        public sectionTitle?: (string | null);
        public sectionBody?: (string | null);
        public sourcesMetadata: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningSearchSourceMetadata[];
        public static create(properties?: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningStepSectionMetadata): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningStepSectionMetadata;
        public static encode(m: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.IBotPlanningStepSectionMetadata, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningStepSectionMetadata;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningStepSectionMetadata;
        public static toObject(m: proto.BotProgressIndicatorMetadata.BotPlanningStepMetadata.BotPlanningStepSectionMetadata, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      enum BotSearchSourceProvider {
        UNKNOWN_PROVIDER = 0,
        OTHER = 1,
        GOOGLE = 2,
        BING = 3
      }
      enum PlanningStepStatus {
        UNKNOWN = 0,
        PLANNED = 1,
        EXECUTING = 2,
        FINISHED = 3
      }
    }
  }
  interface IBotPromotionMessageMetadata {
    promotionType?: (proto.BotPromotionMessageMetadata.BotPromotionType | null);
    buttonTitle?: (string | null);
  }
  class BotPromotionMessageMetadata implements IBotPromotionMessageMetadata {
    constructor(p?: proto.IBotPromotionMessageMetadata);
    public promotionType?: (proto.BotPromotionMessageMetadata.BotPromotionType | null);
    public buttonTitle?: (string | null);
    public static create(properties?: proto.IBotPromotionMessageMetadata): proto.BotPromotionMessageMetadata;
    public static encode(m: proto.IBotPromotionMessageMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotPromotionMessageMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotPromotionMessageMetadata;
    public static toObject(m: proto.BotPromotionMessageMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotPromotionMessageMetadata {
    enum BotPromotionType {
      UNKNOWN_TYPE = 0,
      C50 = 1,
      SURVEY_PLATFORM = 2
    }
  }
  interface IBotPromptSuggestion {
    prompt?: (string | null);
    promptId?: (string | null);
  }
  class BotPromptSuggestion implements IBotPromptSuggestion {
    constructor(p?: proto.IBotPromptSuggestion);
    public prompt?: (string | null);
    public promptId?: (string | null);
    public static create(properties?: proto.IBotPromptSuggestion): proto.BotPromptSuggestion;
    public static encode(m: proto.IBotPromptSuggestion, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotPromptSuggestion;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotPromptSuggestion;
    public static toObject(m: proto.BotPromptSuggestion, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBotPromptSuggestions {
    suggestions?: (proto.IBotPromptSuggestion[] | null);
  }
  class BotPromptSuggestions implements IBotPromptSuggestions {
    constructor(p?: proto.IBotPromptSuggestions);
    public suggestions: proto.IBotPromptSuggestion[];
    public static create(properties?: proto.IBotPromptSuggestions): proto.BotPromptSuggestions;
    public static encode(m: proto.IBotPromptSuggestions, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotPromptSuggestions;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotPromptSuggestions;
    public static toObject(m: proto.BotPromptSuggestions, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBotQuotaMetadata {
    botFeatureQuotaMetadata?: (proto.BotQuotaMetadata.IBotFeatureQuotaMetadata[] | null);
  }
  class BotQuotaMetadata implements IBotQuotaMetadata {
    constructor(p?: proto.IBotQuotaMetadata);
    public botFeatureQuotaMetadata: proto.BotQuotaMetadata.IBotFeatureQuotaMetadata[];
    public static create(properties?: proto.IBotQuotaMetadata): proto.BotQuotaMetadata;
    public static encode(m: proto.IBotQuotaMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotQuotaMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotQuotaMetadata;
    public static toObject(m: proto.BotQuotaMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotQuotaMetadata {
    interface IBotFeatureQuotaMetadata {
      featureType?: (proto.BotQuotaMetadata.BotFeatureQuotaMetadata.BotFeatureType | null);
      remainingQuota?: (number | null);
      expirationTimestamp?: (number | Long$1 | null);
    }
    class BotFeatureQuotaMetadata implements IBotFeatureQuotaMetadata {
      constructor(p?: proto.BotQuotaMetadata.IBotFeatureQuotaMetadata);
      public featureType?: (proto.BotQuotaMetadata.BotFeatureQuotaMetadata.BotFeatureType | null);
      public remainingQuota?: (number | null);
      public expirationTimestamp?: (number | Long$1 | null);
      public static create(properties?: proto.BotQuotaMetadata.IBotFeatureQuotaMetadata): proto.BotQuotaMetadata.BotFeatureQuotaMetadata;
      public static encode(m: proto.BotQuotaMetadata.IBotFeatureQuotaMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.BotQuotaMetadata.BotFeatureQuotaMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.BotQuotaMetadata.BotFeatureQuotaMetadata;
      public static toObject(m: proto.BotQuotaMetadata.BotFeatureQuotaMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace BotFeatureQuotaMetadata {
      enum BotFeatureType {
        UNKNOWN_FEATURE = 0,
        REASONING_FEATURE = 1
      }
    }
  }
  interface IBotReminderMetadata {
    requestMessageKey?: (proto.IMessageKey | null);
    action?: (proto.BotReminderMetadata.ReminderAction | null);
    name?: (string | null);
    nextTriggerTimestamp?: (number | Long$1 | null);
    frequency?: (proto.BotReminderMetadata.ReminderFrequency | null);
  }
  class BotReminderMetadata implements IBotReminderMetadata {
    constructor(p?: proto.IBotReminderMetadata);
    public requestMessageKey?: (proto.IMessageKey | null);
    public action?: (proto.BotReminderMetadata.ReminderAction | null);
    public name?: (string | null);
    public nextTriggerTimestamp?: (number | Long$1 | null);
    public frequency?: (proto.BotReminderMetadata.ReminderFrequency | null);
    public static create(properties?: proto.IBotReminderMetadata): proto.BotReminderMetadata;
    public static encode(m: proto.IBotReminderMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotReminderMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotReminderMetadata;
    public static toObject(m: proto.BotReminderMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotReminderMetadata {
    enum ReminderAction {
      NOTIFY = 1,
      CREATE = 2,
      DELETE = 3,
      UPDATE = 4
    }
    enum ReminderFrequency {
      ONCE = 1,
      DAILY = 2,
      WEEKLY = 3,
      BIWEEKLY = 4,
      MONTHLY = 5
    }
  }
  interface IBotRenderingMetadata {
    keywords?: (proto.BotRenderingMetadata.IKeyword[] | null);
  }
  class BotRenderingMetadata implements IBotRenderingMetadata {
    constructor(p?: proto.IBotRenderingMetadata);
    public keywords: proto.BotRenderingMetadata.IKeyword[];
    public static create(properties?: proto.IBotRenderingMetadata): proto.BotRenderingMetadata;
    public static encode(m: proto.IBotRenderingMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotRenderingMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotRenderingMetadata;
    public static toObject(m: proto.BotRenderingMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotRenderingMetadata {
    interface IKeyword {
      value?: (string | null);
      associatedPrompts?: (string[] | null);
    }
    class Keyword implements IKeyword {
      constructor(p?: proto.BotRenderingMetadata.IKeyword);
      public value?: (string | null);
      public associatedPrompts: string[];
      public static create(properties?: proto.BotRenderingMetadata.IKeyword): proto.BotRenderingMetadata.Keyword;
      public static encode(m: proto.BotRenderingMetadata.IKeyword, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.BotRenderingMetadata.Keyword;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.BotRenderingMetadata.Keyword;
      public static toObject(m: proto.BotRenderingMetadata.Keyword, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IBotSessionMetadata {
    sessionId?: (string | null);
    sessionSource?: (proto.BotSessionSource | null);
  }
  class BotSessionMetadata implements IBotSessionMetadata {
    constructor(p?: proto.IBotSessionMetadata);
    public sessionId?: (string | null);
    public sessionSource?: (proto.BotSessionSource | null);
    public static create(properties?: proto.IBotSessionMetadata): proto.BotSessionMetadata;
    public static encode(m: proto.IBotSessionMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotSessionMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotSessionMetadata;
    public static toObject(m: proto.BotSessionMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  enum BotSessionSource {
    NONE = 0,
    NULL_STATE = 1,
    TYPEAHEAD = 2,
    USER_INPUT = 3,
    EMU_FLASH = 4,
    EMU_FLASH_FOLLOWUP = 5,
    VOICE = 6
  }
  interface IBotSignatureVerificationMetadata {
    proofs?: (proto.IBotSignatureVerificationUseCaseProof[] | null);
  }
  class BotSignatureVerificationMetadata implements IBotSignatureVerificationMetadata {
    constructor(p?: proto.IBotSignatureVerificationMetadata);
    public proofs: proto.IBotSignatureVerificationUseCaseProof[];
    public static create(properties?: proto.IBotSignatureVerificationMetadata): proto.BotSignatureVerificationMetadata;
    public static encode(m: proto.IBotSignatureVerificationMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotSignatureVerificationMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotSignatureVerificationMetadata;
    public static toObject(m: proto.BotSignatureVerificationMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBotSignatureVerificationUseCaseProof {
    version?: (number | null);
    useCase?: (proto.BotSignatureVerificationUseCaseProof.BotSignatureUseCase | null);
    signature?: (Uint8Array | null);
    certificateChain?: (Uint8Array[] | null);
  }
  class BotSignatureVerificationUseCaseProof implements IBotSignatureVerificationUseCaseProof {
    constructor(p?: proto.IBotSignatureVerificationUseCaseProof);
    public version?: (number | null);
    public useCase?: (proto.BotSignatureVerificationUseCaseProof.BotSignatureUseCase | null);
    public signature?: (Uint8Array | null);
    public certificateChain: Uint8Array[];
    public static create(properties?: proto.IBotSignatureVerificationUseCaseProof): proto.BotSignatureVerificationUseCaseProof;
    public static encode(m: proto.IBotSignatureVerificationUseCaseProof, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotSignatureVerificationUseCaseProof;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotSignatureVerificationUseCaseProof;
    public static toObject(m: proto.BotSignatureVerificationUseCaseProof, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotSignatureVerificationUseCaseProof {
    enum BotSignatureUseCase {
      UNSPECIFIED = 0,
      WA_BOT_MSG = 1
    }
  }
  interface IBotSourcesMetadata {
    sources?: (proto.BotSourcesMetadata.IBotSourceItem[] | null);
  }
  class BotSourcesMetadata implements IBotSourcesMetadata {
    constructor(p?: proto.IBotSourcesMetadata);
    public sources: proto.BotSourcesMetadata.IBotSourceItem[];
    public static create(properties?: proto.IBotSourcesMetadata): proto.BotSourcesMetadata;
    public static encode(m: proto.IBotSourcesMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotSourcesMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotSourcesMetadata;
    public static toObject(m: proto.BotSourcesMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotSourcesMetadata {
    interface IBotSourceItem {
      provider?: (proto.BotSourcesMetadata.BotSourceItem.SourceProvider | null);
      thumbnailCdnUrl?: (string | null);
      sourceProviderUrl?: (string | null);
      sourceQuery?: (string | null);
      faviconCdnUrl?: (string | null);
      citationNumber?: (number | null);
      sourceTitle?: (string | null);
    }
    class BotSourceItem implements IBotSourceItem {
      constructor(p?: proto.BotSourcesMetadata.IBotSourceItem);
      public provider?: (proto.BotSourcesMetadata.BotSourceItem.SourceProvider | null);
      public thumbnailCdnUrl?: (string | null);
      public sourceProviderUrl?: (string | null);
      public sourceQuery?: (string | null);
      public faviconCdnUrl?: (string | null);
      public citationNumber?: (number | null);
      public sourceTitle?: (string | null);
      public static create(properties?: proto.BotSourcesMetadata.IBotSourceItem): proto.BotSourcesMetadata.BotSourceItem;
      public static encode(m: proto.BotSourcesMetadata.IBotSourceItem, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.BotSourcesMetadata.BotSourceItem;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.BotSourcesMetadata.BotSourceItem;
      public static toObject(m: proto.BotSourcesMetadata.BotSourceItem, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace BotSourceItem {
      enum SourceProvider {
        UNKNOWN = 0,
        BING = 1,
        GOOGLE = 2,
        SUPPORT = 3,
        OTHER = 4
      }
    }
  }
  interface IBotSuggestedPromptMetadata {
    suggestedPrompts?: (string[] | null);
    selectedPromptIndex?: (number | null);
    promptSuggestions?: (proto.IBotPromptSuggestions | null);
    selectedPromptId?: (string | null);
  }
  class BotSuggestedPromptMetadata implements IBotSuggestedPromptMetadata {
    constructor(p?: proto.IBotSuggestedPromptMetadata);
    public suggestedPrompts: string[];
    public selectedPromptIndex?: (number | null);
    public promptSuggestions?: (proto.IBotPromptSuggestions | null);
    public selectedPromptId?: (string | null);
    public static create(properties?: proto.IBotSuggestedPromptMetadata): proto.BotSuggestedPromptMetadata;
    public static encode(m: proto.IBotSuggestedPromptMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotSuggestedPromptMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotSuggestedPromptMetadata;
    public static toObject(m: proto.BotSuggestedPromptMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IBotUnifiedResponseMutation {
    sbsMetadata?: (proto.BotUnifiedResponseMutation.ISideBySideMetadata | null);
    mediaDetailsMetadataList?: (proto.BotUnifiedResponseMutation.IMediaDetailsMetadata[] | null);
  }
  class BotUnifiedResponseMutation implements IBotUnifiedResponseMutation {
    constructor(p?: proto.IBotUnifiedResponseMutation);
    public sbsMetadata?: (proto.BotUnifiedResponseMutation.ISideBySideMetadata | null);
    public mediaDetailsMetadataList: proto.BotUnifiedResponseMutation.IMediaDetailsMetadata[];
    public static create(properties?: proto.IBotUnifiedResponseMutation): proto.BotUnifiedResponseMutation;
    public static encode(m: proto.IBotUnifiedResponseMutation, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.BotUnifiedResponseMutation;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.BotUnifiedResponseMutation;
    public static toObject(m: proto.BotUnifiedResponseMutation, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace BotUnifiedResponseMutation {
    interface IMediaDetailsMetadata {
      id?: (string | null);
      highResMedia?: (proto.IBotMediaMetadata | null);
      previewMedia?: (proto.IBotMediaMetadata | null);
    }
    class MediaDetailsMetadata implements IMediaDetailsMetadata {
      constructor(p?: proto.BotUnifiedResponseMutation.IMediaDetailsMetadata);
      public id?: (string | null);
      public highResMedia?: (proto.IBotMediaMetadata | null);
      public previewMedia?: (proto.IBotMediaMetadata | null);
      public static create(properties?: proto.BotUnifiedResponseMutation.IMediaDetailsMetadata): proto.BotUnifiedResponseMutation.MediaDetailsMetadata;
      public static encode(m: proto.BotUnifiedResponseMutation.IMediaDetailsMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.BotUnifiedResponseMutation.MediaDetailsMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.BotUnifiedResponseMutation.MediaDetailsMetadata;
      public static toObject(m: proto.BotUnifiedResponseMutation.MediaDetailsMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ISideBySideMetadata {
      primaryResponseId?: (string | null);
      surveyCtaHasRendered?: (boolean | null);
    }
    class SideBySideMetadata implements ISideBySideMetadata {
      constructor(p?: proto.BotUnifiedResponseMutation.ISideBySideMetadata);
      public primaryResponseId?: (string | null);
      public surveyCtaHasRendered?: (boolean | null);
      public static create(properties?: proto.BotUnifiedResponseMutation.ISideBySideMetadata): proto.BotUnifiedResponseMutation.SideBySideMetadata;
      public static encode(m: proto.BotUnifiedResponseMutation.ISideBySideMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.BotUnifiedResponseMutation.SideBySideMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.BotUnifiedResponseMutation.SideBySideMetadata;
      public static toObject(m: proto.BotUnifiedResponseMutation.SideBySideMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface ICallLogRecord {
    callResult?: (proto.CallLogRecord.CallResult | null);
    isDndMode?: (boolean | null);
    silenceReason?: (proto.CallLogRecord.SilenceReason | null);
    duration?: (number | Long$1 | null);
    startTime?: (number | Long$1 | null);
    isIncoming?: (boolean | null);
    isVideo?: (boolean | null);
    isCallLink?: (boolean | null);
    callLinkToken?: (string | null);
    scheduledCallId?: (string | null);
    callId?: (string | null);
    callCreatorJid?: (string | null);
    groupJid?: (string | null);
    participants?: (proto.CallLogRecord.IParticipantInfo[] | null);
    callType?: (proto.CallLogRecord.CallType | null);
  }
  class CallLogRecord implements ICallLogRecord {
    constructor(p?: proto.ICallLogRecord);
    public callResult?: (proto.CallLogRecord.CallResult | null);
    public isDndMode?: (boolean | null);
    public silenceReason?: (proto.CallLogRecord.SilenceReason | null);
    public duration?: (number | Long$1 | null);
    public startTime?: (number | Long$1 | null);
    public isIncoming?: (boolean | null);
    public isVideo?: (boolean | null);
    public isCallLink?: (boolean | null);
    public callLinkToken?: (string | null);
    public scheduledCallId?: (string | null);
    public callId?: (string | null);
    public callCreatorJid?: (string | null);
    public groupJid?: (string | null);
    public participants: proto.CallLogRecord.IParticipantInfo[];
    public callType?: (proto.CallLogRecord.CallType | null);
    public static create(properties?: proto.ICallLogRecord): proto.CallLogRecord;
    public static encode(m: proto.ICallLogRecord, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.CallLogRecord;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.CallLogRecord;
    public static toObject(m: proto.CallLogRecord, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace CallLogRecord {
    enum CallResult {
      CONNECTED = 0,
      REJECTED = 1,
      CANCELLED = 2,
      ACCEPTEDELSEWHERE = 3,
      MISSED = 4,
      INVALID = 5,
      UNAVAILABLE = 6,
      UPCOMING = 7,
      FAILED = 8,
      ABANDONED = 9,
      ONGOING = 10
    }
    enum CallType {
      REGULAR = 0,
      SCHEDULED_CALL = 1,
      VOICE_CHAT = 2
    }
    interface IParticipantInfo {
      userJid?: (string | null);
      callResult?: (proto.CallLogRecord.CallResult | null);
    }
    class ParticipantInfo implements IParticipantInfo {
      constructor(p?: proto.CallLogRecord.IParticipantInfo);
      public userJid?: (string | null);
      public callResult?: (proto.CallLogRecord.CallResult | null);
      public static create(properties?: proto.CallLogRecord.IParticipantInfo): proto.CallLogRecord.ParticipantInfo;
      public static encode(m: proto.CallLogRecord.IParticipantInfo, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.CallLogRecord.ParticipantInfo;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.CallLogRecord.ParticipantInfo;
      public static toObject(m: proto.CallLogRecord.ParticipantInfo, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum SilenceReason {
      NONE = 0,
      SCHEDULED = 1,
      PRIVACY = 2,
      LIGHTWEIGHT = 3
    }
  }
  interface ICertChain {
    leaf?: (proto.CertChain.INoiseCertificate | null);
    intermediate?: (proto.CertChain.INoiseCertificate | null);
  }
  class CertChain implements ICertChain {
    constructor(p?: proto.ICertChain);
    public leaf?: (proto.CertChain.INoiseCertificate | null);
    public intermediate?: (proto.CertChain.INoiseCertificate | null);
    public static create(properties?: proto.ICertChain): proto.CertChain;
    public static encode(m: proto.ICertChain, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.CertChain;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.CertChain;
    public static toObject(m: proto.CertChain, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace CertChain {
    interface INoiseCertificate {
      details?: (Uint8Array | null);
      signature?: (Uint8Array | null);
    }
    class NoiseCertificate implements INoiseCertificate {
      constructor(p?: proto.CertChain.INoiseCertificate);
      public details?: (Uint8Array | null);
      public signature?: (Uint8Array | null);
      public static create(properties?: proto.CertChain.INoiseCertificate): proto.CertChain.NoiseCertificate;
      public static encode(m: proto.CertChain.INoiseCertificate, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.CertChain.NoiseCertificate;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.CertChain.NoiseCertificate;
      public static toObject(m: proto.CertChain.NoiseCertificate, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace NoiseCertificate {
      interface IDetails {
        serial?: (number | null);
        issuerSerial?: (number | null);
        key?: (Uint8Array | null);
        notBefore?: (number | Long$1 | null);
        notAfter?: (number | Long$1 | null);
      }
      class Details implements IDetails {
        constructor(p?: proto.CertChain.NoiseCertificate.IDetails);
        public serial?: (number | null);
        public issuerSerial?: (number | null);
        public key?: (Uint8Array | null);
        public notBefore?: (number | Long$1 | null);
        public notAfter?: (number | Long$1 | null);
        public static create(properties?: proto.CertChain.NoiseCertificate.IDetails): proto.CertChain.NoiseCertificate.Details;
        public static encode(m: proto.CertChain.NoiseCertificate.IDetails, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.CertChain.NoiseCertificate.Details;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.CertChain.NoiseCertificate.Details;
        public static toObject(m: proto.CertChain.NoiseCertificate.Details, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
  }
  interface IChatLockSettings {
    hideLockedChats?: (boolean | null);
    secretCode?: (proto.IUserPassword | null);
  }
  class ChatLockSettings implements IChatLockSettings {
    constructor(p?: proto.IChatLockSettings);
    public hideLockedChats?: (boolean | null);
    public secretCode?: (proto.IUserPassword | null);
    public static create(properties?: proto.IChatLockSettings): proto.ChatLockSettings;
    public static encode(m: proto.IChatLockSettings, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ChatLockSettings;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ChatLockSettings;
    public static toObject(m: proto.ChatLockSettings, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IChatRowOpaqueData {
    draftMessage?: (proto.ChatRowOpaqueData.IDraftMessage | null);
  }
  class ChatRowOpaqueData implements IChatRowOpaqueData {
    constructor(p?: proto.IChatRowOpaqueData);
    public draftMessage?: (proto.ChatRowOpaqueData.IDraftMessage | null);
    public static create(properties?: proto.IChatRowOpaqueData): proto.ChatRowOpaqueData;
    public static encode(m: proto.IChatRowOpaqueData, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ChatRowOpaqueData;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ChatRowOpaqueData;
    public static toObject(m: proto.ChatRowOpaqueData, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace ChatRowOpaqueData {
    interface IDraftMessage {
      text?: (string | null);
      omittedUrl?: (string | null);
      ctwaContextLinkData?: (proto.ChatRowOpaqueData.DraftMessage.ICtwaContextLinkData | null);
      ctwaContext?: (proto.ChatRowOpaqueData.DraftMessage.ICtwaContextData | null);
      timestamp?: (number | Long$1 | null);
    }
    class DraftMessage implements IDraftMessage {
      constructor(p?: proto.ChatRowOpaqueData.IDraftMessage);
      public text?: (string | null);
      public omittedUrl?: (string | null);
      public ctwaContextLinkData?: (proto.ChatRowOpaqueData.DraftMessage.ICtwaContextLinkData | null);
      public ctwaContext?: (proto.ChatRowOpaqueData.DraftMessage.ICtwaContextData | null);
      public timestamp?: (number | Long$1 | null);
      public static create(properties?: proto.ChatRowOpaqueData.IDraftMessage): proto.ChatRowOpaqueData.DraftMessage;
      public static encode(m: proto.ChatRowOpaqueData.IDraftMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ChatRowOpaqueData.DraftMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ChatRowOpaqueData.DraftMessage;
      public static toObject(m: proto.ChatRowOpaqueData.DraftMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace DraftMessage {
      interface ICtwaContextData {
        conversionSource?: (string | null);
        conversionData?: (Uint8Array | null);
        sourceUrl?: (string | null);
        sourceId?: (string | null);
        sourceType?: (string | null);
        title?: (string | null);
        description?: (string | null);
        thumbnail?: (string | null);
        thumbnailUrl?: (string | null);
        mediaType?: (proto.ChatRowOpaqueData.DraftMessage.CtwaContextData.ContextInfoExternalAdReplyInfoMediaType | null);
        mediaUrl?: (string | null);
        isSuspiciousLink?: (boolean | null);
      }
      class CtwaContextData implements ICtwaContextData {
        constructor(p?: proto.ChatRowOpaqueData.DraftMessage.ICtwaContextData);
        public conversionSource?: (string | null);
        public conversionData?: (Uint8Array | null);
        public sourceUrl?: (string | null);
        public sourceId?: (string | null);
        public sourceType?: (string | null);
        public title?: (string | null);
        public description?: (string | null);
        public thumbnail?: (string | null);
        public thumbnailUrl?: (string | null);
        public mediaType?: (proto.ChatRowOpaqueData.DraftMessage.CtwaContextData.ContextInfoExternalAdReplyInfoMediaType | null);
        public mediaUrl?: (string | null);
        public isSuspiciousLink?: (boolean | null);
        public static create(properties?: proto.ChatRowOpaqueData.DraftMessage.ICtwaContextData): proto.ChatRowOpaqueData.DraftMessage.CtwaContextData;
        public static encode(m: proto.ChatRowOpaqueData.DraftMessage.ICtwaContextData, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.ChatRowOpaqueData.DraftMessage.CtwaContextData;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.ChatRowOpaqueData.DraftMessage.CtwaContextData;
        public static toObject(m: proto.ChatRowOpaqueData.DraftMessage.CtwaContextData, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace CtwaContextData {
        enum ContextInfoExternalAdReplyInfoMediaType {
          NONE = 0,
          IMAGE = 1,
          VIDEO = 2
        }
      }
      interface ICtwaContextLinkData {
        context?: (string | null);
        sourceUrl?: (string | null);
        icebreaker?: (string | null);
        phone?: (string | null);
      }
      class CtwaContextLinkData implements ICtwaContextLinkData {
        constructor(p?: proto.ChatRowOpaqueData.DraftMessage.ICtwaContextLinkData);
        public context?: (string | null);
        public sourceUrl?: (string | null);
        public icebreaker?: (string | null);
        public phone?: (string | null);
        public static create(properties?: proto.ChatRowOpaqueData.DraftMessage.ICtwaContextLinkData): proto.ChatRowOpaqueData.DraftMessage.CtwaContextLinkData;
        public static encode(m: proto.ChatRowOpaqueData.DraftMessage.ICtwaContextLinkData, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.ChatRowOpaqueData.DraftMessage.CtwaContextLinkData;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.ChatRowOpaqueData.DraftMessage.CtwaContextLinkData;
        public static toObject(m: proto.ChatRowOpaqueData.DraftMessage.CtwaContextLinkData, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
  }
  interface ICitation {
    title?: (string | null);
    subtitle?: (string | null);
    cmsId?: (string | null);
    imageUrl?: (string | null);
  }
  class Citation implements ICitation {
    constructor(p?: proto.ICitation);
    public title: string;
    public subtitle: string;
    public cmsId: string;
    public imageUrl: string;
    public static create(properties?: proto.ICitation): proto.Citation;
    public static encode(m: proto.ICitation, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Citation;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Citation;
    public static toObject(m: proto.Citation, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IClientPairingProps {
    isChatDbLidMigrated?: (boolean | null);
    isSyncdPureLidSession?: (boolean | null);
    isSyncdSnapshotRecoveryEnabled?: (boolean | null);
  }
  class ClientPairingProps implements IClientPairingProps {
    constructor(p?: proto.IClientPairingProps);
    public isChatDbLidMigrated?: (boolean | null);
    public isSyncdPureLidSession?: (boolean | null);
    public isSyncdSnapshotRecoveryEnabled?: (boolean | null);
    public static create(properties?: proto.IClientPairingProps): proto.ClientPairingProps;
    public static encode(m: proto.IClientPairingProps, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ClientPairingProps;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ClientPairingProps;
    public static toObject(m: proto.ClientPairingProps, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IClientPayload {
    username?: (number | Long$1 | null);
    passive?: (boolean | null);
    userAgent?: (proto.ClientPayload.IUserAgent | null);
    webInfo?: (proto.ClientPayload.IWebInfo | null);
    pushName?: (string | null);
    sessionId?: (number | null);
    shortConnect?: (boolean | null);
    connectType?: (proto.ClientPayload.ConnectType | null);
    connectReason?: (proto.ClientPayload.ConnectReason | null);
    shards?: (number[] | null);
    dnsSource?: (proto.ClientPayload.IDNSSource | null);
    connectAttemptCount?: (number | null);
    device?: (number | null);
    devicePairingData?: (proto.ClientPayload.IDevicePairingRegistrationData | null);
    product?: (proto.ClientPayload.Product | null);
    fbCat?: (Uint8Array | null);
    fbUserAgent?: (Uint8Array | null);
    oc?: (boolean | null);
    lc?: (number | null);
    iosAppExtension?: (proto.ClientPayload.IOSAppExtension | null);
    fbAppId?: (number | Long$1 | null);
    fbDeviceId?: (Uint8Array | null);
    pull?: (boolean | null);
    paddingBytes?: (Uint8Array | null);
    yearClass?: (number | null);
    memClass?: (number | null);
    interopData?: (proto.ClientPayload.IInteropData | null);
    trafficAnonymization?: (proto.ClientPayload.TrafficAnonymization | null);
    lidDbMigrated?: (boolean | null);
    accountType?: (proto.ClientPayload.AccountType | null);
    connectionSequenceInfo?: (number | null);
    paaLink?: (boolean | null);
    preacksCount?: (number | null);
    processingQueueSize?: (number | null);
  }
  class ClientPayload implements IClientPayload {
    constructor(p?: proto.IClientPayload);
    public username?: (number | Long$1 | null);
    public passive?: (boolean | null);
    public userAgent?: (proto.ClientPayload.IUserAgent | null);
    public webInfo?: (proto.ClientPayload.IWebInfo | null);
    public pushName?: (string | null);
    public sessionId?: (number | null);
    public shortConnect?: (boolean | null);
    public connectType?: (proto.ClientPayload.ConnectType | null);
    public connectReason?: (proto.ClientPayload.ConnectReason | null);
    public shards: number[];
    public dnsSource?: (proto.ClientPayload.IDNSSource | null);
    public connectAttemptCount?: (number | null);
    public device?: (number | null);
    public devicePairingData?: (proto.ClientPayload.IDevicePairingRegistrationData | null);
    public product?: (proto.ClientPayload.Product | null);
    public fbCat?: (Uint8Array | null);
    public fbUserAgent?: (Uint8Array | null);
    public oc?: (boolean | null);
    public lc?: (number | null);
    public iosAppExtension?: (proto.ClientPayload.IOSAppExtension | null);
    public fbAppId?: (number | Long$1 | null);
    public fbDeviceId?: (Uint8Array | null);
    public pull?: (boolean | null);
    public paddingBytes?: (Uint8Array | null);
    public yearClass?: (number | null);
    public memClass?: (number | null);
    public interopData?: (proto.ClientPayload.IInteropData | null);
    public trafficAnonymization?: (proto.ClientPayload.TrafficAnonymization | null);
    public lidDbMigrated?: (boolean | null);
    public accountType?: (proto.ClientPayload.AccountType | null);
    public connectionSequenceInfo?: (number | null);
    public paaLink?: (boolean | null);
    public preacksCount?: (number | null);
    public processingQueueSize?: (number | null);
    public static create(properties?: proto.IClientPayload): proto.ClientPayload;
    public static encode(m: proto.IClientPayload, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ClientPayload;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ClientPayload;
    public static toObject(m: proto.ClientPayload, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace ClientPayload {
    enum AccountType {
      DEFAULT = 0,
      GUEST = 1
    }
    enum ConnectReason {
      PUSH = 0,
      USER_ACTIVATED = 1,
      SCHEDULED = 2,
      ERROR_RECONNECT = 3,
      NETWORK_SWITCH = 4,
      PING_RECONNECT = 5,
      UNKNOWN = 6
    }
    enum ConnectType {
      CELLULAR_UNKNOWN = 0,
      WIFI_UNKNOWN = 1,
      CELLULAR_EDGE = 100,
      CELLULAR_IDEN = 101,
      CELLULAR_UMTS = 102,
      CELLULAR_EVDO = 103,
      CELLULAR_GPRS = 104,
      CELLULAR_HSDPA = 105,
      CELLULAR_HSUPA = 106,
      CELLULAR_HSPA = 107,
      CELLULAR_CDMA = 108,
      CELLULAR_1XRTT = 109,
      CELLULAR_EHRPD = 110,
      CELLULAR_LTE = 111,
      CELLULAR_HSPAP = 112
    }
    interface IDNSSource {
      dnsMethod?: (proto.ClientPayload.DNSSource.DNSResolutionMethod | null);
      appCached?: (boolean | null);
    }
    class DNSSource implements IDNSSource {
      constructor(p?: proto.ClientPayload.IDNSSource);
      public dnsMethod?: (proto.ClientPayload.DNSSource.DNSResolutionMethod | null);
      public appCached?: (boolean | null);
      public static create(properties?: proto.ClientPayload.IDNSSource): proto.ClientPayload.DNSSource;
      public static encode(m: proto.ClientPayload.IDNSSource, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ClientPayload.DNSSource;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ClientPayload.DNSSource;
      public static toObject(m: proto.ClientPayload.DNSSource, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace DNSSource {
      enum DNSResolutionMethod {
        SYSTEM = 0,
        GOOGLE = 1,
        HARDCODED = 2,
        OVERRIDE = 3,
        FALLBACK = 4,
        MNS = 5
      }
    }
    interface IDevicePairingRegistrationData {
      eRegid?: (Uint8Array | null);
      eKeytype?: (Uint8Array | null);
      eIdent?: (Uint8Array | null);
      eSkeyId?: (Uint8Array | null);
      eSkeyVal?: (Uint8Array | null);
      eSkeySig?: (Uint8Array | null);
      buildHash?: (Uint8Array | null);
      deviceProps?: (Uint8Array | null);
    }
    class DevicePairingRegistrationData implements IDevicePairingRegistrationData {
      constructor(p?: proto.ClientPayload.IDevicePairingRegistrationData);
      public eRegid?: (Uint8Array | null);
      public eKeytype?: (Uint8Array | null);
      public eIdent?: (Uint8Array | null);
      public eSkeyId?: (Uint8Array | null);
      public eSkeyVal?: (Uint8Array | null);
      public eSkeySig?: (Uint8Array | null);
      public buildHash?: (Uint8Array | null);
      public deviceProps?: (Uint8Array | null);
      public static create(properties?: proto.ClientPayload.IDevicePairingRegistrationData): proto.ClientPayload.DevicePairingRegistrationData;
      public static encode(m: proto.ClientPayload.IDevicePairingRegistrationData, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ClientPayload.DevicePairingRegistrationData;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ClientPayload.DevicePairingRegistrationData;
      public static toObject(m: proto.ClientPayload.DevicePairingRegistrationData, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum IOSAppExtension {
      SHARE_EXTENSION = 0,
      SERVICE_EXTENSION = 1,
      INTENTS_EXTENSION = 2
    }
    interface IInteropData {
      accountId?: (number | Long$1 | null);
      token?: (Uint8Array | null);
      enableReadReceipts?: (boolean | null);
    }
    class InteropData implements IInteropData {
      constructor(p?: proto.ClientPayload.IInteropData);
      public accountId?: (number | Long$1 | null);
      public token?: (Uint8Array | null);
      public enableReadReceipts?: (boolean | null);
      public static create(properties?: proto.ClientPayload.IInteropData): proto.ClientPayload.InteropData;
      public static encode(m: proto.ClientPayload.IInteropData, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ClientPayload.InteropData;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ClientPayload.InteropData;
      public static toObject(m: proto.ClientPayload.InteropData, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum Product {
      WHATSAPP = 0,
      MESSENGER = 1,
      INTEROP = 2,
      INTEROP_MSGR = 3,
      WHATSAPP_LID = 4
    }
    enum TrafficAnonymization {
      OFF = 0,
      STANDARD = 1
    }
    interface IUserAgent {
      platform?: (proto.ClientPayload.UserAgent.Platform | null);
      appVersion?: (proto.ClientPayload.UserAgent.IAppVersion | null);
      mcc?: (string | null);
      mnc?: (string | null);
      osVersion?: (string | null);
      manufacturer?: (string | null);
      device?: (string | null);
      osBuildNumber?: (string | null);
      phoneId?: (string | null);
      releaseChannel?: (proto.ClientPayload.UserAgent.ReleaseChannel | null);
      localeLanguageIso6391?: (string | null);
      localeCountryIso31661Alpha2?: (string | null);
      deviceBoard?: (string | null);
      deviceExpId?: (string | null);
      deviceType?: (proto.ClientPayload.UserAgent.DeviceType | null);
      deviceModelType?: (string | null);
    }
    class UserAgent implements IUserAgent {
      constructor(p?: proto.ClientPayload.IUserAgent);
      public platform?: (proto.ClientPayload.UserAgent.Platform | null);
      public appVersion?: (proto.ClientPayload.UserAgent.IAppVersion | null);
      public mcc?: (string | null);
      public mnc?: (string | null);
      public osVersion?: (string | null);
      public manufacturer?: (string | null);
      public device?: (string | null);
      public osBuildNumber?: (string | null);
      public phoneId?: (string | null);
      public releaseChannel?: (proto.ClientPayload.UserAgent.ReleaseChannel | null);
      public localeLanguageIso6391?: (string | null);
      public localeCountryIso31661Alpha2?: (string | null);
      public deviceBoard?: (string | null);
      public deviceExpId?: (string | null);
      public deviceType?: (proto.ClientPayload.UserAgent.DeviceType | null);
      public deviceModelType?: (string | null);
      public static create(properties?: proto.ClientPayload.IUserAgent): proto.ClientPayload.UserAgent;
      public static encode(m: proto.ClientPayload.IUserAgent, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ClientPayload.UserAgent;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ClientPayload.UserAgent;
      public static toObject(m: proto.ClientPayload.UserAgent, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace UserAgent {
      interface IAppVersion {
        primary?: (number | null);
        secondary?: (number | null);
        tertiary?: (number | null);
        quaternary?: (number | null);
        quinary?: (number | null);
      }
      class AppVersion implements IAppVersion {
        constructor(p?: proto.ClientPayload.UserAgent.IAppVersion);
        public primary?: (number | null);
        public secondary?: (number | null);
        public tertiary?: (number | null);
        public quaternary?: (number | null);
        public quinary?: (number | null);
        public static create(properties?: proto.ClientPayload.UserAgent.IAppVersion): proto.ClientPayload.UserAgent.AppVersion;
        public static encode(m: proto.ClientPayload.UserAgent.IAppVersion, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.ClientPayload.UserAgent.AppVersion;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.ClientPayload.UserAgent.AppVersion;
        public static toObject(m: proto.ClientPayload.UserAgent.AppVersion, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      enum DeviceType {
        PHONE = 0,
        TABLET = 1,
        DESKTOP = 2,
        WEARABLE = 3,
        VR = 4
      }
      enum Platform {
        ANDROID = 0,
        IOS = 1,
        WINDOWS_PHONE = 2,
        BLACKBERRY = 3,
        BLACKBERRYX = 4,
        S40 = 5,
        S60 = 6,
        PYTHON_CLIENT = 7,
        TIZEN = 8,
        ENTERPRISE = 9,
        SMB_ANDROID = 10,
        KAIOS = 11,
        SMB_IOS = 12,
        WINDOWS = 13,
        WEB = 14,
        PORTAL = 15,
        GREEN_ANDROID = 16,
        GREEN_IPHONE = 17,
        BLUE_ANDROID = 18,
        BLUE_IPHONE = 19,
        FBLITE_ANDROID = 20,
        MLITE_ANDROID = 21,
        IGLITE_ANDROID = 22,
        PAGE = 23,
        MACOS = 24,
        OCULUS_MSG = 25,
        OCULUS_CALL = 26,
        MILAN = 27,
        CAPI = 28,
        WEAROS = 29,
        ARDEVICE = 30,
        VRDEVICE = 31,
        BLUE_WEB = 32,
        IPAD = 33,
        TEST = 34,
        SMART_GLASSES = 35,
        BLUE_VR = 36,
        AR_WRIST = 37
      }
      enum ReleaseChannel {
        RELEASE = 0,
        BETA = 1,
        ALPHA = 2,
        DEBUG = 3
      }
    }
    interface IWebInfo {
      refToken?: (string | null);
      version?: (string | null);
      webdPayload?: (proto.ClientPayload.WebInfo.IWebdPayload | null);
      webSubPlatform?: (proto.ClientPayload.WebInfo.WebSubPlatform | null);
    }
    class WebInfo implements IWebInfo {
      constructor(p?: proto.ClientPayload.IWebInfo);
      public refToken?: (string | null);
      public version?: (string | null);
      public webdPayload?: (proto.ClientPayload.WebInfo.IWebdPayload | null);
      public webSubPlatform?: (proto.ClientPayload.WebInfo.WebSubPlatform | null);
      public static create(properties?: proto.ClientPayload.IWebInfo): proto.ClientPayload.WebInfo;
      public static encode(m: proto.ClientPayload.IWebInfo, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ClientPayload.WebInfo;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ClientPayload.WebInfo;
      public static toObject(m: proto.ClientPayload.WebInfo, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace WebInfo {
      enum WebSubPlatform {
        WEB_BROWSER = 0,
        APP_STORE = 1,
        WIN_STORE = 2,
        DARWIN = 3,
        WIN32 = 4,
        WIN_HYBRID = 5
      }
      interface IWebdPayload {
        usesParticipantInKey?: (boolean | null);
        supportsStarredMessages?: (boolean | null);
        supportsDocumentMessages?: (boolean | null);
        supportsUrlMessages?: (boolean | null);
        supportsMediaRetry?: (boolean | null);
        supportsE2EImage?: (boolean | null);
        supportsE2EVideo?: (boolean | null);
        supportsE2EAudio?: (boolean | null);
        supportsE2EDocument?: (boolean | null);
        documentTypes?: (string | null);
        features?: (Uint8Array | null);
      }
      class WebdPayload implements IWebdPayload {
        constructor(p?: proto.ClientPayload.WebInfo.IWebdPayload);
        public usesParticipantInKey?: (boolean | null);
        public supportsStarredMessages?: (boolean | null);
        public supportsDocumentMessages?: (boolean | null);
        public supportsUrlMessages?: (boolean | null);
        public supportsMediaRetry?: (boolean | null);
        public supportsE2EImage?: (boolean | null);
        public supportsE2EVideo?: (boolean | null);
        public supportsE2EAudio?: (boolean | null);
        public supportsE2EDocument?: (boolean | null);
        public documentTypes?: (string | null);
        public features?: (Uint8Array | null);
        public static create(properties?: proto.ClientPayload.WebInfo.IWebdPayload): proto.ClientPayload.WebInfo.WebdPayload;
        public static encode(m: proto.ClientPayload.WebInfo.IWebdPayload, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.ClientPayload.WebInfo.WebdPayload;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.ClientPayload.WebInfo.WebdPayload;
        public static toObject(m: proto.ClientPayload.WebInfo.WebdPayload, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
  }
  enum CollectionName {
    COLLECTION_NAME_UNKNOWN = 0,
    REGULAR = 1,
    REGULAR_LOW = 2,
    REGULAR_HIGH = 3,
    CRITICAL_BLOCK = 4,
    CRITICAL_UNBLOCK_LOW = 5
  }
  interface ICommentMetadata {
    commentParentKey?: (proto.IMessageKey | null);
    replyCount?: (number | null);
  }
  class CommentMetadata implements ICommentMetadata {
    constructor(p?: proto.ICommentMetadata);
    public commentParentKey?: (proto.IMessageKey | null);
    public replyCount?: (number | null);
    public static create(properties?: proto.ICommentMetadata): proto.CommentMetadata;
    public static encode(m: proto.ICommentMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.CommentMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.CommentMetadata;
    public static toObject(m: proto.CommentMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ICompanionCommitment {
    hash?: (Uint8Array | null);
  }
  class CompanionCommitment implements ICompanionCommitment {
    constructor(p?: proto.ICompanionCommitment);
    public hash?: (Uint8Array | null);
    public static create(properties?: proto.ICompanionCommitment): proto.CompanionCommitment;
    public static encode(m: proto.ICompanionCommitment, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.CompanionCommitment;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.CompanionCommitment;
    public static toObject(m: proto.CompanionCommitment, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ICompanionEphemeralIdentity {
    publicKey?: (Uint8Array | null);
    deviceType?: (proto.DeviceProps.PlatformType | null);
    ref?: (string | null);
  }
  class CompanionEphemeralIdentity implements ICompanionEphemeralIdentity {
    constructor(p?: proto.ICompanionEphemeralIdentity);
    public publicKey?: (Uint8Array | null);
    public deviceType?: (proto.DeviceProps.PlatformType | null);
    public ref?: (string | null);
    public static create(properties?: proto.ICompanionEphemeralIdentity): proto.CompanionEphemeralIdentity;
    public static encode(m: proto.ICompanionEphemeralIdentity, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.CompanionEphemeralIdentity;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.CompanionEphemeralIdentity;
    public static toObject(m: proto.CompanionEphemeralIdentity, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IConfig {
    field?: ({
      [k: string]: proto.IField;
    } | null);
    version?: (number | null);
  }
  class Config implements IConfig {
    constructor(p?: proto.IConfig);
    public field: {
      [k: string]: proto.IField;
    };
    public version?: (number | null);
    public static create(properties?: proto.IConfig): proto.Config;
    public static encode(m: proto.IConfig, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Config;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Config;
    public static toObject(m: proto.Config, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IContextInfo {
    stanzaId?: (string | null);
    participant?: (string | null);
    quotedMessage?: (proto.IMessage | null);
    remoteJid?: (string | null);
    mentionedJid?: (string[] | null);
    conversionSource?: (string | null);
    conversionData?: (Uint8Array | null);
    conversionDelaySeconds?: (number | null);
    forwardingScore?: (number | null);
    isForwarded?: (boolean | null);
    quotedAd?: (proto.ContextInfo.IAdReplyInfo | null);
    placeholderKey?: (proto.IMessageKey | null);
    expiration?: (number | null);
    ephemeralSettingTimestamp?: (number | Long$1 | null);
    ephemeralSharedSecret?: (Uint8Array | null);
    externalAdReply?: (proto.ContextInfo.IExternalAdReplyInfo | null);
    entryPointConversionSource?: (string | null);
    entryPointConversionApp?: (string | null);
    entryPointConversionDelaySeconds?: (number | null);
    disappearingMode?: (proto.IDisappearingMode | null);
    actionLink?: (proto.IActionLink | null);
    groupSubject?: (string | null);
    parentGroupJid?: (string | null);
    trustBannerType?: (string | null);
    trustBannerAction?: (number | null);
    isSampled?: (boolean | null);
    groupMentions?: (proto.IGroupMention[] | null);
    utm?: (proto.ContextInfo.IUTMInfo | null);
    forwardedNewsletterMessageInfo?: (proto.ContextInfo.IForwardedNewsletterMessageInfo | null);
    businessMessageForwardInfo?: (proto.ContextInfo.IBusinessMessageForwardInfo | null);
    smbClientCampaignId?: (string | null);
    smbServerCampaignId?: (string | null);
    dataSharingContext?: (proto.ContextInfo.IDataSharingContext | null);
    alwaysShowAdAttribution?: (boolean | null);
    featureEligibilities?: (proto.ContextInfo.IFeatureEligibilities | null);
    entryPointConversionExternalSource?: (string | null);
    entryPointConversionExternalMedium?: (string | null);
    ctwaSignals?: (string | null);
    ctwaPayload?: (Uint8Array | null);
    forwardedAiBotMessageInfo?: (proto.IForwardedAIBotMessageInfo | null);
    statusAttributionType?: (proto.ContextInfo.StatusAttributionType | null);
    urlTrackingMap?: (proto.IUrlTrackingMap | null);
    pairedMediaType?: (proto.ContextInfo.PairedMediaType | null);
    rankingVersion?: (number | null);
    memberLabel?: (proto.IMemberLabel | null);
    isQuestion?: (boolean | null);
    statusSourceType?: (proto.ContextInfo.StatusSourceType | null);
    statusAttributions?: (proto.IStatusAttribution[] | null);
    isGroupStatus?: (boolean | null);
    forwardOrigin?: (proto.ContextInfo.ForwardOrigin | null);
    questionReplyQuotedMessage?: (proto.ContextInfo.IQuestionReplyQuotedMessage | null);
    statusAudienceMetadata?: (proto.ContextInfo.IStatusAudienceMetadata | null);
    nonJidMentions?: (number | null);
    quotedType?: (proto.ContextInfo.QuotedType | null);
    botMessageSharingInfo?: (proto.IBotMessageSharingInfo | null);
  }
  class ContextInfo implements IContextInfo {
    constructor(p?: proto.IContextInfo);
    public stanzaId?: (string | null);
    public participant?: (string | null);
    public quotedMessage?: (proto.IMessage | null);
    public remoteJid?: (string | null);
    public mentionedJid: string[];
    public conversionSource?: (string | null);
    public conversionData?: (Uint8Array | null);
    public conversionDelaySeconds?: (number | null);
    public forwardingScore?: (number | null);
    public isForwarded?: (boolean | null);
    public quotedAd?: (proto.ContextInfo.IAdReplyInfo | null);
    public placeholderKey?: (proto.IMessageKey | null);
    public expiration?: (number | null);
    public ephemeralSettingTimestamp?: (number | Long$1 | null);
    public ephemeralSharedSecret?: (Uint8Array | null);
    public externalAdReply?: (proto.ContextInfo.IExternalAdReplyInfo | null);
    public entryPointConversionSource?: (string | null);
    public entryPointConversionApp?: (string | null);
    public entryPointConversionDelaySeconds?: (number | null);
    public disappearingMode?: (proto.IDisappearingMode | null);
    public actionLink?: (proto.IActionLink | null);
    public groupSubject?: (string | null);
    public parentGroupJid?: (string | null);
    public trustBannerType?: (string | null);
    public trustBannerAction?: (number | null);
    public isSampled?: (boolean | null);
    public groupMentions: proto.IGroupMention[];
    public utm?: (proto.ContextInfo.IUTMInfo | null);
    public forwardedNewsletterMessageInfo?: (proto.ContextInfo.IForwardedNewsletterMessageInfo | null);
    public businessMessageForwardInfo?: (proto.ContextInfo.IBusinessMessageForwardInfo | null);
    public smbClientCampaignId?: (string | null);
    public smbServerCampaignId?: (string | null);
    public dataSharingContext?: (proto.ContextInfo.IDataSharingContext | null);
    public alwaysShowAdAttribution?: (boolean | null);
    public featureEligibilities?: (proto.ContextInfo.IFeatureEligibilities | null);
    public entryPointConversionExternalSource?: (string | null);
    public entryPointConversionExternalMedium?: (string | null);
    public ctwaSignals?: (string | null);
    public ctwaPayload?: (Uint8Array | null);
    public forwardedAiBotMessageInfo?: (proto.IForwardedAIBotMessageInfo | null);
    public statusAttributionType?: (proto.ContextInfo.StatusAttributionType | null);
    public urlTrackingMap?: (proto.IUrlTrackingMap | null);
    public pairedMediaType?: (proto.ContextInfo.PairedMediaType | null);
    public rankingVersion?: (number | null);
    public memberLabel?: (proto.IMemberLabel | null);
    public isQuestion?: (boolean | null);
    public statusSourceType?: (proto.ContextInfo.StatusSourceType | null);
    public statusAttributions: proto.IStatusAttribution[];
    public isGroupStatus?: (boolean | null);
    public forwardOrigin?: (proto.ContextInfo.ForwardOrigin | null);
    public questionReplyQuotedMessage?: (proto.ContextInfo.IQuestionReplyQuotedMessage | null);
    public statusAudienceMetadata?: (proto.ContextInfo.IStatusAudienceMetadata | null);
    public nonJidMentions?: (number | null);
    public quotedType?: (proto.ContextInfo.QuotedType | null);
    public botMessageSharingInfo?: (proto.IBotMessageSharingInfo | null);
    public static create(properties?: proto.IContextInfo): proto.ContextInfo;
    public static encode(m: proto.IContextInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ContextInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ContextInfo;
    public static toObject(m: proto.ContextInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace ContextInfo {
    interface IAdReplyInfo {
      advertiserName?: (string | null);
      mediaType?: (proto.ContextInfo.AdReplyInfo.MediaType | null);
      jpegThumbnail?: (Uint8Array | null);
      caption?: (string | null);
    }
    class AdReplyInfo implements IAdReplyInfo {
      constructor(p?: proto.ContextInfo.IAdReplyInfo);
      public advertiserName?: (string | null);
      public mediaType?: (proto.ContextInfo.AdReplyInfo.MediaType | null);
      public jpegThumbnail?: (Uint8Array | null);
      public caption?: (string | null);
      public static create(properties?: proto.ContextInfo.IAdReplyInfo): proto.ContextInfo.AdReplyInfo;
      public static encode(m: proto.ContextInfo.IAdReplyInfo, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ContextInfo.AdReplyInfo;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ContextInfo.AdReplyInfo;
      public static toObject(m: proto.ContextInfo.AdReplyInfo, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace AdReplyInfo {
      enum MediaType {
        NONE = 0,
        IMAGE = 1,
        VIDEO = 2
      }
    }
    interface IBusinessMessageForwardInfo {
      businessOwnerJid?: (string | null);
    }
    class BusinessMessageForwardInfo implements IBusinessMessageForwardInfo {
      constructor(p?: proto.ContextInfo.IBusinessMessageForwardInfo);
      public businessOwnerJid?: (string | null);
      public static create(properties?: proto.ContextInfo.IBusinessMessageForwardInfo): proto.ContextInfo.BusinessMessageForwardInfo;
      public static encode(m: proto.ContextInfo.IBusinessMessageForwardInfo, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ContextInfo.BusinessMessageForwardInfo;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ContextInfo.BusinessMessageForwardInfo;
      public static toObject(m: proto.ContextInfo.BusinessMessageForwardInfo, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IDataSharingContext {
      showMmDisclosure?: (boolean | null);
      encryptedSignalTokenConsented?: (string | null);
      parameters?: (proto.ContextInfo.DataSharingContext.IParameters[] | null);
      dataSharingFlags?: (number | null);
    }
    class DataSharingContext implements IDataSharingContext {
      constructor(p?: proto.ContextInfo.IDataSharingContext);
      public showMmDisclosure?: (boolean | null);
      public encryptedSignalTokenConsented?: (string | null);
      public parameters: proto.ContextInfo.DataSharingContext.IParameters[];
      public dataSharingFlags?: (number | null);
      public static create(properties?: proto.ContextInfo.IDataSharingContext): proto.ContextInfo.DataSharingContext;
      public static encode(m: proto.ContextInfo.IDataSharingContext, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ContextInfo.DataSharingContext;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ContextInfo.DataSharingContext;
      public static toObject(m: proto.ContextInfo.DataSharingContext, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace DataSharingContext {
      enum DataSharingFlags {
        SHOW_MM_DISCLOSURE_ON_CLICK = 1,
        SHOW_MM_DISCLOSURE_ON_READ = 2
      }
      interface IParameters {
        key?: (string | null);
        stringData?: (string | null);
        intData?: (number | Long$1 | null);
        floatData?: (number | null);
        contents?: (proto.ContextInfo.DataSharingContext.IParameters | null);
      }
      class Parameters implements IParameters {
        constructor(p?: proto.ContextInfo.DataSharingContext.IParameters);
        public key?: (string | null);
        public stringData?: (string | null);
        public intData?: (number | Long$1 | null);
        public floatData?: (number | null);
        public contents?: (proto.ContextInfo.DataSharingContext.IParameters | null);
        public static create(properties?: proto.ContextInfo.DataSharingContext.IParameters): proto.ContextInfo.DataSharingContext.Parameters;
        public static encode(m: proto.ContextInfo.DataSharingContext.IParameters, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.ContextInfo.DataSharingContext.Parameters;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.ContextInfo.DataSharingContext.Parameters;
        public static toObject(m: proto.ContextInfo.DataSharingContext.Parameters, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface IExternalAdReplyInfo {
      title?: (string | null);
      body?: (string | null);
      mediaType?: (proto.ContextInfo.ExternalAdReplyInfo.MediaType | null);
      thumbnailUrl?: (string | null);
      mediaUrl?: (string | null);
      thumbnail?: (Uint8Array | null);
      sourceType?: (string | null);
      sourceId?: (string | null);
      sourceUrl?: (string | null);
      containsAutoReply?: (boolean | null);
      renderLargerThumbnail?: (boolean | null);
      showAdAttribution?: (boolean | null);
      ctwaClid?: (string | null);
      ref?: (string | null);
      clickToWhatsappCall?: (boolean | null);
      adContextPreviewDismissed?: (boolean | null);
      sourceApp?: (string | null);
      automatedGreetingMessageShown?: (boolean | null);
      greetingMessageBody?: (string | null);
      ctaPayload?: (string | null);
      disableNudge?: (boolean | null);
      originalImageUrl?: (string | null);
      automatedGreetingMessageCtaType?: (string | null);
      wtwaAdFormat?: (boolean | null);
      adType?: (proto.ContextInfo.ExternalAdReplyInfo.AdType | null);
      wtwaWebsiteUrl?: (string | null);
      adPreviewUrl?: (string | null);
    }
    class ExternalAdReplyInfo implements IExternalAdReplyInfo {
      constructor(p?: proto.ContextInfo.IExternalAdReplyInfo);
      public title?: (string | null);
      public body?: (string | null);
      public mediaType?: (proto.ContextInfo.ExternalAdReplyInfo.MediaType | null);
      public thumbnailUrl?: (string | null);
      public mediaUrl?: (string | null);
      public thumbnail?: (Uint8Array | null);
      public sourceType?: (string | null);
      public sourceId?: (string | null);
      public sourceUrl?: (string | null);
      public containsAutoReply?: (boolean | null);
      public renderLargerThumbnail?: (boolean | null);
      public showAdAttribution?: (boolean | null);
      public ctwaClid?: (string | null);
      public ref?: (string | null);
      public clickToWhatsappCall?: (boolean | null);
      public adContextPreviewDismissed?: (boolean | null);
      public sourceApp?: (string | null);
      public automatedGreetingMessageShown?: (boolean | null);
      public greetingMessageBody?: (string | null);
      public ctaPayload?: (string | null);
      public disableNudge?: (boolean | null);
      public originalImageUrl?: (string | null);
      public automatedGreetingMessageCtaType?: (string | null);
      public wtwaAdFormat?: (boolean | null);
      public adType?: (proto.ContextInfo.ExternalAdReplyInfo.AdType | null);
      public wtwaWebsiteUrl?: (string | null);
      public adPreviewUrl?: (string | null);
      public static create(properties?: proto.ContextInfo.IExternalAdReplyInfo): proto.ContextInfo.ExternalAdReplyInfo;
      public static encode(m: proto.ContextInfo.IExternalAdReplyInfo, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ContextInfo.ExternalAdReplyInfo;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ContextInfo.ExternalAdReplyInfo;
      public static toObject(m: proto.ContextInfo.ExternalAdReplyInfo, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ExternalAdReplyInfo {
      enum AdType {
        CTWA = 0,
        CAWC = 1
      }
      enum MediaType {
        NONE = 0,
        IMAGE = 1,
        VIDEO = 2
      }
    }
    interface IFeatureEligibilities {
      cannotBeReactedTo?: (boolean | null);
      cannotBeRanked?: (boolean | null);
      canRequestFeedback?: (boolean | null);
      canBeReshared?: (boolean | null);
      canReceiveMultiReact?: (boolean | null);
    }
    class FeatureEligibilities implements IFeatureEligibilities {
      constructor(p?: proto.ContextInfo.IFeatureEligibilities);
      public cannotBeReactedTo?: (boolean | null);
      public cannotBeRanked?: (boolean | null);
      public canRequestFeedback?: (boolean | null);
      public canBeReshared?: (boolean | null);
      public canReceiveMultiReact?: (boolean | null);
      public static create(properties?: proto.ContextInfo.IFeatureEligibilities): proto.ContextInfo.FeatureEligibilities;
      public static encode(m: proto.ContextInfo.IFeatureEligibilities, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ContextInfo.FeatureEligibilities;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ContextInfo.FeatureEligibilities;
      public static toObject(m: proto.ContextInfo.FeatureEligibilities, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum ForwardOrigin {
      UNKNOWN = 0,
      CHAT = 1,
      STATUS = 2,
      CHANNELS = 3,
      META_AI = 4,
      UGC = 5
    }
    interface IForwardedNewsletterMessageInfo {
      newsletterJid?: (string | null);
      serverMessageId?: (number | null);
      newsletterName?: (string | null);
      contentType?: (proto.ContextInfo.ForwardedNewsletterMessageInfo.ContentType | null);
      accessibilityText?: (string | null);
    }
    class ForwardedNewsletterMessageInfo implements IForwardedNewsletterMessageInfo {
      constructor(p?: proto.ContextInfo.IForwardedNewsletterMessageInfo);
      public newsletterJid?: (string | null);
      public serverMessageId?: (number | null);
      public newsletterName?: (string | null);
      public contentType?: (proto.ContextInfo.ForwardedNewsletterMessageInfo.ContentType | null);
      public accessibilityText?: (string | null);
      public static create(properties?: proto.ContextInfo.IForwardedNewsletterMessageInfo): proto.ContextInfo.ForwardedNewsletterMessageInfo;
      public static encode(m: proto.ContextInfo.IForwardedNewsletterMessageInfo, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ContextInfo.ForwardedNewsletterMessageInfo;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ContextInfo.ForwardedNewsletterMessageInfo;
      public static toObject(m: proto.ContextInfo.ForwardedNewsletterMessageInfo, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ForwardedNewsletterMessageInfo {
      enum ContentType {
        UPDATE = 1,
        UPDATE_CARD = 2,
        LINK_CARD = 3
      }
    }
    enum PairedMediaType {
      NOT_PAIRED_MEDIA = 0,
      SD_VIDEO_PARENT = 1,
      HD_VIDEO_CHILD = 2,
      SD_IMAGE_PARENT = 3,
      HD_IMAGE_CHILD = 4,
      MOTION_PHOTO_PARENT = 5,
      MOTION_PHOTO_CHILD = 6,
      HEVC_VIDEO_PARENT = 7,
      HEVC_VIDEO_CHILD = 8
    }
    interface IQuestionReplyQuotedMessage {
      serverQuestionId?: (number | null);
      quotedQuestion?: (proto.IMessage | null);
      quotedResponse?: (proto.IMessage | null);
    }
    class QuestionReplyQuotedMessage implements IQuestionReplyQuotedMessage {
      constructor(p?: proto.ContextInfo.IQuestionReplyQuotedMessage);
      public serverQuestionId?: (number | null);
      public quotedQuestion?: (proto.IMessage | null);
      public quotedResponse?: (proto.IMessage | null);
      public static create(properties?: proto.ContextInfo.IQuestionReplyQuotedMessage): proto.ContextInfo.QuestionReplyQuotedMessage;
      public static encode(m: proto.ContextInfo.IQuestionReplyQuotedMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ContextInfo.QuestionReplyQuotedMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ContextInfo.QuestionReplyQuotedMessage;
      public static toObject(m: proto.ContextInfo.QuestionReplyQuotedMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum QuotedType {
      EXPLICIT = 0,
      AUTO = 1
    }
    enum StatusAttributionType {
      NONE = 0,
      RESHARED_FROM_MENTION = 1,
      RESHARED_FROM_POST = 2,
      RESHARED_FROM_POST_MANY_TIMES = 3,
      FORWARDED_FROM_STATUS = 4
    }
    interface IStatusAudienceMetadata {
      audienceType?: (proto.ContextInfo.StatusAudienceMetadata.AudienceType | null);
    }
    class StatusAudienceMetadata implements IStatusAudienceMetadata {
      constructor(p?: proto.ContextInfo.IStatusAudienceMetadata);
      public audienceType?: (proto.ContextInfo.StatusAudienceMetadata.AudienceType | null);
      public static create(properties?: proto.ContextInfo.IStatusAudienceMetadata): proto.ContextInfo.StatusAudienceMetadata;
      public static encode(m: proto.ContextInfo.IStatusAudienceMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ContextInfo.StatusAudienceMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ContextInfo.StatusAudienceMetadata;
      public static toObject(m: proto.ContextInfo.StatusAudienceMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace StatusAudienceMetadata {
      enum AudienceType {
        UNKNOWN = 0,
        CLOSE_FRIENDS = 1
      }
    }
    enum StatusSourceType {
      IMAGE = 0,
      VIDEO = 1,
      GIF = 2,
      AUDIO = 3,
      TEXT = 4,
      MUSIC_STANDALONE = 5
    }
    interface IUTMInfo {
      utmSource?: (string | null);
      utmCampaign?: (string | null);
    }
    class UTMInfo implements IUTMInfo {
      constructor(p?: proto.ContextInfo.IUTMInfo);
      public utmSource?: (string | null);
      public utmCampaign?: (string | null);
      public static create(properties?: proto.ContextInfo.IUTMInfo): proto.ContextInfo.UTMInfo;
      public static encode(m: proto.ContextInfo.IUTMInfo, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.ContextInfo.UTMInfo;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.ContextInfo.UTMInfo;
      public static toObject(m: proto.ContextInfo.UTMInfo, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IConversation {
    id?: (string | null);
    messages?: (proto.IHistorySyncMsg[] | null);
    newJid?: (string | null);
    oldJid?: (string | null);
    lastMsgTimestamp?: (number | Long$1 | null);
    unreadCount?: (number | null);
    readOnly?: (boolean | null);
    endOfHistoryTransfer?: (boolean | null);
    ephemeralExpiration?: (number | null);
    ephemeralSettingTimestamp?: (number | Long$1 | null);
    endOfHistoryTransferType?: (proto.Conversation.EndOfHistoryTransferType | null);
    conversationTimestamp?: (number | Long$1 | null);
    name?: (string | null);
    pHash?: (string | null);
    notSpam?: (boolean | null);
    archived?: (boolean | null);
    disappearingMode?: (proto.IDisappearingMode | null);
    unreadMentionCount?: (number | null);
    markedAsUnread?: (boolean | null);
    participant?: (proto.IGroupParticipant[] | null);
    tcToken?: (Uint8Array | null);
    tcTokenTimestamp?: (number | Long$1 | null);
    contactPrimaryIdentityKey?: (Uint8Array | null);
    pinned?: (number | null);
    muteEndTime?: (number | Long$1 | null);
    wallpaper?: (proto.IWallpaperSettings | null);
    mediaVisibility?: (proto.MediaVisibility | null);
    tcTokenSenderTimestamp?: (number | Long$1 | null);
    suspended?: (boolean | null);
    terminated?: (boolean | null);
    createdAt?: (number | Long$1 | null);
    createdBy?: (string | null);
    description?: (string | null);
    support?: (boolean | null);
    isParentGroup?: (boolean | null);
    parentGroupId?: (string | null);
    isDefaultSubgroup?: (boolean | null);
    displayName?: (string | null);
    pnJid?: (string | null);
    shareOwnPn?: (boolean | null);
    pnhDuplicateLidThread?: (boolean | null);
    lidJid?: (string | null);
    username?: (string | null);
    lidOriginType?: (string | null);
    commentsCount?: (number | null);
    locked?: (boolean | null);
    systemMessageToInsert?: (proto.PrivacySystemMessage | null);
    capiCreatedGroup?: (boolean | null);
    accountLid?: (string | null);
    limitSharing?: (boolean | null);
    limitSharingSettingTimestamp?: (number | Long$1 | null);
    limitSharingTrigger?: (proto.LimitSharing.TriggerType | null);
    limitSharingInitiatedByMe?: (boolean | null);
    maibaAiThreadEnabled?: (boolean | null);
  }
  class Conversation implements IConversation {
    constructor(p?: proto.IConversation);
    public id: string;
    public messages: proto.IHistorySyncMsg[];
    public newJid?: (string | null);
    public oldJid?: (string | null);
    public lastMsgTimestamp?: (number | Long$1 | null);
    public unreadCount?: (number | null);
    public readOnly?: (boolean | null);
    public endOfHistoryTransfer?: (boolean | null);
    public ephemeralExpiration?: (number | null);
    public ephemeralSettingTimestamp?: (number | Long$1 | null);
    public endOfHistoryTransferType?: (proto.Conversation.EndOfHistoryTransferType | null);
    public conversationTimestamp?: (number | Long$1 | null);
    public name?: (string | null);
    public pHash?: (string | null);
    public notSpam?: (boolean | null);
    public archived?: (boolean | null);
    public disappearingMode?: (proto.IDisappearingMode | null);
    public unreadMentionCount?: (number | null);
    public markedAsUnread?: (boolean | null);
    public participant: proto.IGroupParticipant[];
    public tcToken?: (Uint8Array | null);
    public tcTokenTimestamp?: (number | Long$1 | null);
    public contactPrimaryIdentityKey?: (Uint8Array | null);
    public pinned?: (number | null);
    public muteEndTime?: (number | Long$1 | null);
    public wallpaper?: (proto.IWallpaperSettings | null);
    public mediaVisibility?: (proto.MediaVisibility | null);
    public tcTokenSenderTimestamp?: (number | Long$1 | null);
    public suspended?: (boolean | null);
    public terminated?: (boolean | null);
    public createdAt?: (number | Long$1 | null);
    public createdBy?: (string | null);
    public description?: (string | null);
    public support?: (boolean | null);
    public isParentGroup?: (boolean | null);
    public parentGroupId?: (string | null);
    public isDefaultSubgroup?: (boolean | null);
    public displayName?: (string | null);
    public pnJid?: (string | null);
    public shareOwnPn?: (boolean | null);
    public pnhDuplicateLidThread?: (boolean | null);
    public lidJid?: (string | null);
    public username?: (string | null);
    public lidOriginType?: (string | null);
    public commentsCount?: (number | null);
    public locked?: (boolean | null);
    public systemMessageToInsert?: (proto.PrivacySystemMessage | null);
    public capiCreatedGroup?: (boolean | null);
    public accountLid?: (string | null);
    public limitSharing?: (boolean | null);
    public limitSharingSettingTimestamp?: (number | Long$1 | null);
    public limitSharingTrigger?: (proto.LimitSharing.TriggerType | null);
    public limitSharingInitiatedByMe?: (boolean | null);
    public maibaAiThreadEnabled?: (boolean | null);
    public static create(properties?: proto.IConversation): proto.Conversation;
    public static encode(m: proto.IConversation, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Conversation;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Conversation;
    public static toObject(m: proto.Conversation, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace Conversation {
    enum EndOfHistoryTransferType {
      COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY = 0,
      COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY = 1,
      COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY = 2
    }
  }
  interface IDeviceCapabilities {
    chatLockSupportLevel?: (proto.DeviceCapabilities.ChatLockSupportLevel | null);
    lidMigration?: (proto.DeviceCapabilities.ILIDMigration | null);
    businessBroadcast?: (proto.DeviceCapabilities.IBusinessBroadcast | null);
    userHasAvatar?: (proto.DeviceCapabilities.IUserHasAvatar | null);
    memberNameTagPrimarySupport?: (proto.DeviceCapabilities.MemberNameTagPrimarySupport | null);
  }
  class DeviceCapabilities implements IDeviceCapabilities {
    constructor(p?: proto.IDeviceCapabilities);
    public chatLockSupportLevel?: (proto.DeviceCapabilities.ChatLockSupportLevel | null);
    public lidMigration?: (proto.DeviceCapabilities.ILIDMigration | null);
    public businessBroadcast?: (proto.DeviceCapabilities.IBusinessBroadcast | null);
    public userHasAvatar?: (proto.DeviceCapabilities.IUserHasAvatar | null);
    public memberNameTagPrimarySupport?: (proto.DeviceCapabilities.MemberNameTagPrimarySupport | null);
    public static create(properties?: proto.IDeviceCapabilities): proto.DeviceCapabilities;
    public static encode(m: proto.IDeviceCapabilities, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.DeviceCapabilities;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.DeviceCapabilities;
    public static toObject(m: proto.DeviceCapabilities, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace DeviceCapabilities {
    interface IBusinessBroadcast {
      importListEnabled?: (boolean | null);
    }
    class BusinessBroadcast implements IBusinessBroadcast {
      constructor(p?: proto.DeviceCapabilities.IBusinessBroadcast);
      public importListEnabled?: (boolean | null);
      public static create(properties?: proto.DeviceCapabilities.IBusinessBroadcast): proto.DeviceCapabilities.BusinessBroadcast;
      public static encode(m: proto.DeviceCapabilities.IBusinessBroadcast, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.DeviceCapabilities.BusinessBroadcast;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.DeviceCapabilities.BusinessBroadcast;
      public static toObject(m: proto.DeviceCapabilities.BusinessBroadcast, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum ChatLockSupportLevel {
      NONE = 0,
      MINIMAL = 1,
      FULL = 2
    }
    interface ILIDMigration {
      chatDbMigrationTimestamp?: (number | Long$1 | null);
    }
    class LIDMigration implements ILIDMigration {
      constructor(p?: proto.DeviceCapabilities.ILIDMigration);
      public chatDbMigrationTimestamp?: (number | Long$1 | null);
      public static create(properties?: proto.DeviceCapabilities.ILIDMigration): proto.DeviceCapabilities.LIDMigration;
      public static encode(m: proto.DeviceCapabilities.ILIDMigration, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.DeviceCapabilities.LIDMigration;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.DeviceCapabilities.LIDMigration;
      public static toObject(m: proto.DeviceCapabilities.LIDMigration, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum MemberNameTagPrimarySupport {
      DISABLED = 0,
      RECEIVER_ENABLED = 1,
      SENDER_ENABLED = 2
    }
    interface IUserHasAvatar {
      userHasAvatar?: (boolean | null);
    }
    class UserHasAvatar implements IUserHasAvatar {
      constructor(p?: proto.DeviceCapabilities.IUserHasAvatar);
      public userHasAvatar?: (boolean | null);
      public static create(properties?: proto.DeviceCapabilities.IUserHasAvatar): proto.DeviceCapabilities.UserHasAvatar;
      public static encode(m: proto.DeviceCapabilities.IUserHasAvatar, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.DeviceCapabilities.UserHasAvatar;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.DeviceCapabilities.UserHasAvatar;
      public static toObject(m: proto.DeviceCapabilities.UserHasAvatar, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IDeviceConsistencyCodeMessage {
    generation?: (number | null);
    signature?: (Uint8Array | null);
  }
  class DeviceConsistencyCodeMessage implements IDeviceConsistencyCodeMessage {
    constructor(p?: proto.IDeviceConsistencyCodeMessage);
    public generation?: (number | null);
    public signature?: (Uint8Array | null);
    public static create(properties?: proto.IDeviceConsistencyCodeMessage): proto.DeviceConsistencyCodeMessage;
    public static encode(m: proto.IDeviceConsistencyCodeMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.DeviceConsistencyCodeMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.DeviceConsistencyCodeMessage;
    public static toObject(m: proto.DeviceConsistencyCodeMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IDeviceListMetadata {
    senderKeyHash?: (Uint8Array | null);
    senderTimestamp?: (number | Long$1 | null);
    senderKeyIndexes?: (number[] | null);
    senderAccountType?: (proto.ADVEncryptionType | null);
    receiverAccountType?: (proto.ADVEncryptionType | null);
    recipientKeyHash?: (Uint8Array | null);
    recipientTimestamp?: (number | Long$1 | null);
    recipientKeyIndexes?: (number[] | null);
  }
  class DeviceListMetadata implements IDeviceListMetadata {
    constructor(p?: proto.IDeviceListMetadata);
    public senderKeyHash?: (Uint8Array | null);
    public senderTimestamp?: (number | Long$1 | null);
    public senderKeyIndexes: number[];
    public senderAccountType?: (proto.ADVEncryptionType | null);
    public receiverAccountType?: (proto.ADVEncryptionType | null);
    public recipientKeyHash?: (Uint8Array | null);
    public recipientTimestamp?: (number | Long$1 | null);
    public recipientKeyIndexes: number[];
    public static create(properties?: proto.IDeviceListMetadata): proto.DeviceListMetadata;
    public static encode(m: proto.IDeviceListMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.DeviceListMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.DeviceListMetadata;
    public static toObject(m: proto.DeviceListMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IDeviceProps {
    os?: (string | null);
    version?: (proto.DeviceProps.IAppVersion | null);
    platformType?: (proto.DeviceProps.PlatformType | null);
    requireFullSync?: (boolean | null);
    historySyncConfig?: (proto.DeviceProps.IHistorySyncConfig | null);
  }
  class DeviceProps implements IDeviceProps {
    constructor(p?: proto.IDeviceProps);
    public os?: (string | null);
    public version?: (proto.DeviceProps.IAppVersion | null);
    public platformType?: (proto.DeviceProps.PlatformType | null);
    public requireFullSync?: (boolean | null);
    public historySyncConfig?: (proto.DeviceProps.IHistorySyncConfig | null);
    public static create(properties?: proto.IDeviceProps): proto.DeviceProps;
    public static encode(m: proto.IDeviceProps, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.DeviceProps;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.DeviceProps;
    public static toObject(m: proto.DeviceProps, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace DeviceProps {
    interface IAppVersion {
      primary?: (number | null);
      secondary?: (number | null);
      tertiary?: (number | null);
      quaternary?: (number | null);
      quinary?: (number | null);
    }
    class AppVersion implements IAppVersion {
      constructor(p?: proto.DeviceProps.IAppVersion);
      public primary?: (number | null);
      public secondary?: (number | null);
      public tertiary?: (number | null);
      public quaternary?: (number | null);
      public quinary?: (number | null);
      public static create(properties?: proto.DeviceProps.IAppVersion): proto.DeviceProps.AppVersion;
      public static encode(m: proto.DeviceProps.IAppVersion, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.DeviceProps.AppVersion;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.DeviceProps.AppVersion;
      public static toObject(m: proto.DeviceProps.AppVersion, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IHistorySyncConfig {
      fullSyncDaysLimit?: (number | null);
      fullSyncSizeMbLimit?: (number | null);
      storageQuotaMb?: (number | null);
      inlineInitialPayloadInE2EeMsg?: (boolean | null);
      recentSyncDaysLimit?: (number | null);
      supportCallLogHistory?: (boolean | null);
      supportBotUserAgentChatHistory?: (boolean | null);
      supportCagReactionsAndPolls?: (boolean | null);
      supportBizHostedMsg?: (boolean | null);
      supportRecentSyncChunkMessageCountTuning?: (boolean | null);
      supportHostedGroupMsg?: (boolean | null);
      supportFbidBotChatHistory?: (boolean | null);
      supportAddOnHistorySyncMigration?: (boolean | null);
      supportMessageAssociation?: (boolean | null);
      supportGroupHistory?: (boolean | null);
      onDemandReady?: (boolean | null);
      supportGuestChat?: (boolean | null);
      completeOnDemandReady?: (boolean | null);
      thumbnailSyncDaysLimit?: (number | null);
    }
    class HistorySyncConfig implements IHistorySyncConfig {
      constructor(p?: proto.DeviceProps.IHistorySyncConfig);
      public fullSyncDaysLimit?: (number | null);
      public fullSyncSizeMbLimit?: (number | null);
      public storageQuotaMb?: (number | null);
      public inlineInitialPayloadInE2EeMsg?: (boolean | null);
      public recentSyncDaysLimit?: (number | null);
      public supportCallLogHistory?: (boolean | null);
      public supportBotUserAgentChatHistory?: (boolean | null);
      public supportCagReactionsAndPolls?: (boolean | null);
      public supportBizHostedMsg?: (boolean | null);
      public supportRecentSyncChunkMessageCountTuning?: (boolean | null);
      public supportHostedGroupMsg?: (boolean | null);
      public supportFbidBotChatHistory?: (boolean | null);
      public supportAddOnHistorySyncMigration?: (boolean | null);
      public supportMessageAssociation?: (boolean | null);
      public supportGroupHistory?: (boolean | null);
      public onDemandReady?: (boolean | null);
      public supportGuestChat?: (boolean | null);
      public completeOnDemandReady?: (boolean | null);
      public thumbnailSyncDaysLimit?: (number | null);
      public static create(properties?: proto.DeviceProps.IHistorySyncConfig): proto.DeviceProps.HistorySyncConfig;
      public static encode(m: proto.DeviceProps.IHistorySyncConfig, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.DeviceProps.HistorySyncConfig;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.DeviceProps.HistorySyncConfig;
      public static toObject(m: proto.DeviceProps.HistorySyncConfig, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum PlatformType {
      UNKNOWN = 0,
      CHROME = 1,
      FIREFOX = 2,
      IE = 3,
      OPERA = 4,
      SAFARI = 5,
      EDGE = 6,
      DESKTOP = 7,
      IPAD = 8,
      ANDROID_TABLET = 9,
      OHANA = 10,
      ALOHA = 11,
      CATALINA = 12,
      TCL_TV = 13,
      IOS_PHONE = 14,
      IOS_CATALYST = 15,
      ANDROID_PHONE = 16,
      ANDROID_AMBIGUOUS = 17,
      WEAR_OS = 18,
      AR_WRIST = 19,
      AR_DEVICE = 20,
      UWP = 21,
      VR = 22,
      CLOUD_API = 23,
      SMARTGLASSES = 24
    }
  }
  interface IDisappearingMode {
    initiator?: (proto.DisappearingMode.Initiator | null);
    trigger?: (proto.DisappearingMode.Trigger | null);
    initiatorDeviceJid?: (string | null);
    initiatedByMe?: (boolean | null);
  }
  class DisappearingMode implements IDisappearingMode {
    constructor(p?: proto.IDisappearingMode);
    public initiator?: (proto.DisappearingMode.Initiator | null);
    public trigger?: (proto.DisappearingMode.Trigger | null);
    public initiatorDeviceJid?: (string | null);
    public initiatedByMe?: (boolean | null);
    public static create(properties?: proto.IDisappearingMode): proto.DisappearingMode;
    public static encode(m: proto.IDisappearingMode, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.DisappearingMode;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.DisappearingMode;
    public static toObject(m: proto.DisappearingMode, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace DisappearingMode {
    enum Initiator {
      CHANGED_IN_CHAT = 0,
      INITIATED_BY_ME = 1,
      INITIATED_BY_OTHER = 2,
      BIZ_UPGRADE_FB_HOSTING = 3
    }
    enum Trigger {
      UNKNOWN = 0,
      CHAT_SETTING = 1,
      ACCOUNT_SETTING = 2,
      BULK_CHANGE = 3,
      BIZ_SUPPORTS_FB_HOSTING = 4,
      UNKNOWN_GROUPS = 5
    }
  }
  interface IEmbeddedContent {
    embeddedMessage?: (proto.IEmbeddedMessage | null);
    embeddedMusic?: (proto.IEmbeddedMusic | null);
  }
  class EmbeddedContent implements IEmbeddedContent {
    constructor(p?: proto.IEmbeddedContent);
    public embeddedMessage?: (proto.IEmbeddedMessage | null);
    public embeddedMusic?: (proto.IEmbeddedMusic | null);
    public content?: ("embeddedMessage" | "embeddedMusic");
    public static create(properties?: proto.IEmbeddedContent): proto.EmbeddedContent;
    public static encode(m: proto.IEmbeddedContent, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.EmbeddedContent;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.EmbeddedContent;
    public static toObject(m: proto.EmbeddedContent, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IEmbeddedMessage {
    stanzaId?: (string | null);
    message?: (proto.IMessage | null);
  }
  class EmbeddedMessage implements IEmbeddedMessage {
    constructor(p?: proto.IEmbeddedMessage);
    public stanzaId?: (string | null);
    public message?: (proto.IMessage | null);
    public static create(properties?: proto.IEmbeddedMessage): proto.EmbeddedMessage;
    public static encode(m: proto.IEmbeddedMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.EmbeddedMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.EmbeddedMessage;
    public static toObject(m: proto.EmbeddedMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IEmbeddedMusic {
    musicContentMediaId?: (string | null);
    songId?: (string | null);
    author?: (string | null);
    title?: (string | null);
    artworkDirectPath?: (string | null);
    artworkSha256?: (Uint8Array | null);
    artworkEncSha256?: (Uint8Array | null);
    artistAttribution?: (string | null);
    countryBlocklist?: (Uint8Array | null);
    isExplicit?: (boolean | null);
    artworkMediaKey?: (Uint8Array | null);
    musicSongStartTimeInMs?: (number | Long$1 | null);
    derivedContentStartTimeInMs?: (number | Long$1 | null);
    overlapDurationInMs?: (number | Long$1 | null);
  }
  class EmbeddedMusic implements IEmbeddedMusic {
    constructor(p?: proto.IEmbeddedMusic);
    public musicContentMediaId?: (string | null);
    public songId?: (string | null);
    public author?: (string | null);
    public title?: (string | null);
    public artworkDirectPath?: (string | null);
    public artworkSha256?: (Uint8Array | null);
    public artworkEncSha256?: (Uint8Array | null);
    public artistAttribution?: (string | null);
    public countryBlocklist?: (Uint8Array | null);
    public isExplicit?: (boolean | null);
    public artworkMediaKey?: (Uint8Array | null);
    public musicSongStartTimeInMs?: (number | Long$1 | null);
    public derivedContentStartTimeInMs?: (number | Long$1 | null);
    public overlapDurationInMs?: (number | Long$1 | null);
    public static create(properties?: proto.IEmbeddedMusic): proto.EmbeddedMusic;
    public static encode(m: proto.IEmbeddedMusic, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.EmbeddedMusic;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.EmbeddedMusic;
    public static toObject(m: proto.EmbeddedMusic, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IEncryptedPairingRequest {
    encryptedPayload?: (Uint8Array | null);
    iv?: (Uint8Array | null);
  }
  class EncryptedPairingRequest implements IEncryptedPairingRequest {
    constructor(p?: proto.IEncryptedPairingRequest);
    public encryptedPayload?: (Uint8Array | null);
    public iv?: (Uint8Array | null);
    public static create(properties?: proto.IEncryptedPairingRequest): proto.EncryptedPairingRequest;
    public static encode(m: proto.IEncryptedPairingRequest, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.EncryptedPairingRequest;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.EncryptedPairingRequest;
    public static toObject(m: proto.EncryptedPairingRequest, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IEphemeralSetting {
    duration?: (number | null);
    timestamp?: (number | Long$1 | null);
  }
  class EphemeralSetting implements IEphemeralSetting {
    constructor(p?: proto.IEphemeralSetting);
    public duration?: (number | null);
    public timestamp?: (number | Long$1 | null);
    public static create(properties?: proto.IEphemeralSetting): proto.EphemeralSetting;
    public static encode(m: proto.IEphemeralSetting, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.EphemeralSetting;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.EphemeralSetting;
    public static toObject(m: proto.EphemeralSetting, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IEventAdditionalMetadata {
    isStale?: (boolean | null);
  }
  class EventAdditionalMetadata implements IEventAdditionalMetadata {
    constructor(p?: proto.IEventAdditionalMetadata);
    public isStale?: (boolean | null);
    public static create(properties?: proto.IEventAdditionalMetadata): proto.EventAdditionalMetadata;
    public static encode(m: proto.IEventAdditionalMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.EventAdditionalMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.EventAdditionalMetadata;
    public static toObject(m: proto.EventAdditionalMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IEventResponse {
    eventResponseMessageKey?: (proto.IMessageKey | null);
    timestampMs?: (number | Long$1 | null);
    eventResponseMessage?: (proto.Message.IEventResponseMessage | null);
    unread?: (boolean | null);
  }
  class EventResponse implements IEventResponse {
    constructor(p?: proto.IEventResponse);
    public eventResponseMessageKey?: (proto.IMessageKey | null);
    public timestampMs?: (number | Long$1 | null);
    public eventResponseMessage?: (proto.Message.IEventResponseMessage | null);
    public unread?: (boolean | null);
    public static create(properties?: proto.IEventResponse): proto.EventResponse;
    public static encode(m: proto.IEventResponse, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.EventResponse;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.EventResponse;
    public static toObject(m: proto.EventResponse, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IExitCode {
    code?: (number | Long$1 | null);
    text?: (string | null);
  }
  class ExitCode implements IExitCode {
    constructor(p?: proto.IExitCode);
    public code?: (number | Long$1 | null);
    public text?: (string | null);
    public static create(properties?: proto.IExitCode): proto.ExitCode;
    public static encode(m: proto.IExitCode, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ExitCode;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ExitCode;
    public static toObject(m: proto.ExitCode, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IExternalBlobReference {
    mediaKey?: (Uint8Array | null);
    directPath?: (string | null);
    handle?: (string | null);
    fileSizeBytes?: (number | Long$1 | null);
    fileSha256?: (Uint8Array | null);
    fileEncSha256?: (Uint8Array | null);
  }
  class ExternalBlobReference implements IExternalBlobReference {
    constructor(p?: proto.IExternalBlobReference);
    public mediaKey?: (Uint8Array | null);
    public directPath?: (string | null);
    public handle?: (string | null);
    public fileSizeBytes?: (number | Long$1 | null);
    public fileSha256?: (Uint8Array | null);
    public fileEncSha256?: (Uint8Array | null);
    public static create(properties?: proto.IExternalBlobReference): proto.ExternalBlobReference;
    public static encode(m: proto.IExternalBlobReference, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ExternalBlobReference;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ExternalBlobReference;
    public static toObject(m: proto.ExternalBlobReference, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IField {
    minVersion?: (number | null);
    maxVersion?: (number | null);
    notReportableMinVersion?: (number | null);
    isMessage?: (boolean | null);
    subfield?: ({
      [k: string]: proto.IField;
    } | null);
  }
  class Field implements IField {
    constructor(p?: proto.IField);
    public minVersion?: (number | null);
    public maxVersion?: (number | null);
    public notReportableMinVersion?: (number | null);
    public isMessage?: (boolean | null);
    public subfield: {
      [k: string]: proto.IField;
    };
    public static create(properties?: proto.IField): proto.Field;
    public static encode(m: proto.IField, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Field;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Field;
    public static toObject(m: proto.Field, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IForwardedAIBotMessageInfo {
    botName?: (string | null);
    botJid?: (string | null);
    creatorName?: (string | null);
  }
  class ForwardedAIBotMessageInfo implements IForwardedAIBotMessageInfo {
    constructor(p?: proto.IForwardedAIBotMessageInfo);
    public botName?: (string | null);
    public botJid?: (string | null);
    public creatorName?: (string | null);
    public static create(properties?: proto.IForwardedAIBotMessageInfo): proto.ForwardedAIBotMessageInfo;
    public static encode(m: proto.IForwardedAIBotMessageInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ForwardedAIBotMessageInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ForwardedAIBotMessageInfo;
    public static toObject(m: proto.ForwardedAIBotMessageInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IGlobalSettings {
    lightThemeWallpaper?: (proto.IWallpaperSettings | null);
    mediaVisibility?: (proto.MediaVisibility | null);
    darkThemeWallpaper?: (proto.IWallpaperSettings | null);
    autoDownloadWiFi?: (proto.IAutoDownloadSettings | null);
    autoDownloadCellular?: (proto.IAutoDownloadSettings | null);
    autoDownloadRoaming?: (proto.IAutoDownloadSettings | null);
    showIndividualNotificationsPreview?: (boolean | null);
    showGroupNotificationsPreview?: (boolean | null);
    disappearingModeDuration?: (number | null);
    disappearingModeTimestamp?: (number | Long$1 | null);
    avatarUserSettings?: (proto.IAvatarUserSettings | null);
    fontSize?: (number | null);
    securityNotifications?: (boolean | null);
    autoUnarchiveChats?: (boolean | null);
    videoQualityMode?: (number | null);
    photoQualityMode?: (number | null);
    individualNotificationSettings?: (proto.INotificationSettings | null);
    groupNotificationSettings?: (proto.INotificationSettings | null);
    chatLockSettings?: (proto.IChatLockSettings | null);
    chatDbLidMigrationTimestamp?: (number | Long$1 | null);
  }
  class GlobalSettings implements IGlobalSettings {
    constructor(p?: proto.IGlobalSettings);
    public lightThemeWallpaper?: (proto.IWallpaperSettings | null);
    public mediaVisibility?: (proto.MediaVisibility | null);
    public darkThemeWallpaper?: (proto.IWallpaperSettings | null);
    public autoDownloadWiFi?: (proto.IAutoDownloadSettings | null);
    public autoDownloadCellular?: (proto.IAutoDownloadSettings | null);
    public autoDownloadRoaming?: (proto.IAutoDownloadSettings | null);
    public showIndividualNotificationsPreview?: (boolean | null);
    public showGroupNotificationsPreview?: (boolean | null);
    public disappearingModeDuration?: (number | null);
    public disappearingModeTimestamp?: (number | Long$1 | null);
    public avatarUserSettings?: (proto.IAvatarUserSettings | null);
    public fontSize?: (number | null);
    public securityNotifications?: (boolean | null);
    public autoUnarchiveChats?: (boolean | null);
    public videoQualityMode?: (number | null);
    public photoQualityMode?: (number | null);
    public individualNotificationSettings?: (proto.INotificationSettings | null);
    public groupNotificationSettings?: (proto.INotificationSettings | null);
    public chatLockSettings?: (proto.IChatLockSettings | null);
    public chatDbLidMigrationTimestamp?: (number | Long$1 | null);
    public static create(properties?: proto.IGlobalSettings): proto.GlobalSettings;
    public static encode(m: proto.IGlobalSettings, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.GlobalSettings;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.GlobalSettings;
    public static toObject(m: proto.GlobalSettings, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IGroupHistoryBundleInfo {
    deprecatedMessageHistoryBundle?: (proto.Message.IMessageHistoryBundle | null);
    processState?: (proto.GroupHistoryBundleInfo.ProcessState | null);
  }
  class GroupHistoryBundleInfo implements IGroupHistoryBundleInfo {
    constructor(p?: proto.IGroupHistoryBundleInfo);
    public deprecatedMessageHistoryBundle?: (proto.Message.IMessageHistoryBundle | null);
    public processState?: (proto.GroupHistoryBundleInfo.ProcessState | null);
    public static create(properties?: proto.IGroupHistoryBundleInfo): proto.GroupHistoryBundleInfo;
    public static encode(m: proto.IGroupHistoryBundleInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.GroupHistoryBundleInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.GroupHistoryBundleInfo;
    public static toObject(m: proto.GroupHistoryBundleInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace GroupHistoryBundleInfo {
    enum ProcessState {
      NOT_INJECTED = 0,
      INJECTED = 1,
      INJECTED_PARTIAL = 2,
      INJECTION_FAILED = 3,
      INJECTION_FAILED_NO_RETRY = 4
    }
  }
  interface IGroupHistoryIndividualMessageInfo {
    bundleMessageKey?: (proto.IMessageKey | null);
    editedAfterReceivedAsHistory?: (boolean | null);
  }
  class GroupHistoryIndividualMessageInfo implements IGroupHistoryIndividualMessageInfo {
    constructor(p?: proto.IGroupHistoryIndividualMessageInfo);
    public bundleMessageKey?: (proto.IMessageKey | null);
    public editedAfterReceivedAsHistory?: (boolean | null);
    public static create(properties?: proto.IGroupHistoryIndividualMessageInfo): proto.GroupHistoryIndividualMessageInfo;
    public static encode(m: proto.IGroupHistoryIndividualMessageInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.GroupHistoryIndividualMessageInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.GroupHistoryIndividualMessageInfo;
    public static toObject(m: proto.GroupHistoryIndividualMessageInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IGroupMention {
    groupJid?: (string | null);
    groupSubject?: (string | null);
  }
  class GroupMention implements IGroupMention {
    constructor(p?: proto.IGroupMention);
    public groupJid?: (string | null);
    public groupSubject?: (string | null);
    public static create(properties?: proto.IGroupMention): proto.GroupMention;
    public static encode(m: proto.IGroupMention, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.GroupMention;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.GroupMention;
    public static toObject(m: proto.GroupMention, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IGroupParticipant {
    userJid?: (string | null);
    rank?: (proto.GroupParticipant.Rank | null);
    memberLabel?: (proto.IMemberLabel | null);
  }
  class GroupParticipant implements IGroupParticipant {
    constructor(p?: proto.IGroupParticipant);
    public userJid: string;
    public rank?: (proto.GroupParticipant.Rank | null);
    public memberLabel?: (proto.IMemberLabel | null);
    public static create(properties?: proto.IGroupParticipant): proto.GroupParticipant;
    public static encode(m: proto.IGroupParticipant, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.GroupParticipant;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.GroupParticipant;
    public static toObject(m: proto.GroupParticipant, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace GroupParticipant {
    enum Rank {
      REGULAR = 0,
      ADMIN = 1,
      SUPERADMIN = 2
    }
  }
  interface IHandshakeMessage {
    clientHello?: (proto.HandshakeMessage.IClientHello | null);
    serverHello?: (proto.HandshakeMessage.IServerHello | null);
    clientFinish?: (proto.HandshakeMessage.IClientFinish | null);
  }
  class HandshakeMessage implements IHandshakeMessage {
    constructor(p?: proto.IHandshakeMessage);
    public clientHello?: (proto.HandshakeMessage.IClientHello | null);
    public serverHello?: (proto.HandshakeMessage.IServerHello | null);
    public clientFinish?: (proto.HandshakeMessage.IClientFinish | null);
    public static create(properties?: proto.IHandshakeMessage): proto.HandshakeMessage;
    public static encode(m: proto.IHandshakeMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.HandshakeMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.HandshakeMessage;
    public static toObject(m: proto.HandshakeMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace HandshakeMessage {
    interface IClientFinish {
      "static"?: (Uint8Array | null);
      payload?: (Uint8Array | null);
      extendedCiphertext?: (Uint8Array | null);
    }
    class ClientFinish implements IClientFinish {
      constructor(p?: proto.HandshakeMessage.IClientFinish);
      public static?: (Uint8Array | null);
      public payload?: (Uint8Array | null);
      public extendedCiphertext?: (Uint8Array | null);
      public static create(properties?: proto.HandshakeMessage.IClientFinish): proto.HandshakeMessage.ClientFinish;
      public static encode(m: proto.HandshakeMessage.IClientFinish, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.HandshakeMessage.ClientFinish;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.HandshakeMessage.ClientFinish;
      public static toObject(m: proto.HandshakeMessage.ClientFinish, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IClientHello {
      ephemeral?: (Uint8Array | null);
      "static"?: (Uint8Array | null);
      payload?: (Uint8Array | null);
      useExtended?: (boolean | null);
      extendedCiphertext?: (Uint8Array | null);
    }
    class ClientHello implements IClientHello {
      constructor(p?: proto.HandshakeMessage.IClientHello);
      public ephemeral?: (Uint8Array | null);
      public static?: (Uint8Array | null);
      public payload?: (Uint8Array | null);
      public useExtended?: (boolean | null);
      public extendedCiphertext?: (Uint8Array | null);
      public static create(properties?: proto.HandshakeMessage.IClientHello): proto.HandshakeMessage.ClientHello;
      public static encode(m: proto.HandshakeMessage.IClientHello, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.HandshakeMessage.ClientHello;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.HandshakeMessage.ClientHello;
      public static toObject(m: proto.HandshakeMessage.ClientHello, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IServerHello {
      ephemeral?: (Uint8Array | null);
      "static"?: (Uint8Array | null);
      payload?: (Uint8Array | null);
      extendedStatic?: (Uint8Array | null);
    }
    class ServerHello implements IServerHello {
      constructor(p?: proto.HandshakeMessage.IServerHello);
      public ephemeral?: (Uint8Array | null);
      public static?: (Uint8Array | null);
      public payload?: (Uint8Array | null);
      public extendedStatic?: (Uint8Array | null);
      public static create(properties?: proto.HandshakeMessage.IServerHello): proto.HandshakeMessage.ServerHello;
      public static encode(m: proto.HandshakeMessage.IServerHello, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.HandshakeMessage.ServerHello;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.HandshakeMessage.ServerHello;
      public static toObject(m: proto.HandshakeMessage.ServerHello, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IHistorySync {
    syncType?: (proto.HistorySync.HistorySyncType | null);
    conversations?: (proto.IConversation[] | null);
    statusV3Messages?: (proto.IWebMessageInfo[] | null);
    chunkOrder?: (number | null);
    progress?: (number | null);
    pushnames?: (proto.IPushname[] | null);
    globalSettings?: (proto.IGlobalSettings | null);
    threadIdUserSecret?: (Uint8Array | null);
    threadDsTimeframeOffset?: (number | null);
    recentStickers?: (proto.IStickerMetadata[] | null);
    pastParticipants?: (proto.IPastParticipants[] | null);
    callLogRecords?: (proto.ICallLogRecord[] | null);
    aiWaitListState?: (proto.HistorySync.BotAIWaitListState | null);
    phoneNumberToLidMappings?: (proto.IPhoneNumberToLIDMapping[] | null);
    companionMetaNonce?: (string | null);
    shareableChatIdentifierEncryptionKey?: (Uint8Array | null);
    accounts?: (proto.IAccount[] | null);
  }
  class HistorySync implements IHistorySync {
    constructor(p?: proto.IHistorySync);
    public syncType: proto.HistorySync.HistorySyncType;
    public conversations: proto.IConversation[];
    public statusV3Messages: proto.IWebMessageInfo[];
    public chunkOrder?: (number | null);
    public progress?: (number | null);
    public pushnames: proto.IPushname[];
    public globalSettings?: (proto.IGlobalSettings | null);
    public threadIdUserSecret?: (Uint8Array | null);
    public threadDsTimeframeOffset?: (number | null);
    public recentStickers: proto.IStickerMetadata[];
    public pastParticipants: proto.IPastParticipants[];
    public callLogRecords: proto.ICallLogRecord[];
    public aiWaitListState?: (proto.HistorySync.BotAIWaitListState | null);
    public phoneNumberToLidMappings: proto.IPhoneNumberToLIDMapping[];
    public companionMetaNonce?: (string | null);
    public shareableChatIdentifierEncryptionKey?: (Uint8Array | null);
    public accounts: proto.IAccount[];
    public static create(properties?: proto.IHistorySync): proto.HistorySync;
    public static encode(m: proto.IHistorySync, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.HistorySync;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.HistorySync;
    public static toObject(m: proto.HistorySync, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace HistorySync {
    enum BotAIWaitListState {
      IN_WAITLIST = 0,
      AI_AVAILABLE = 1
    }
    enum HistorySyncType {
      INITIAL_BOOTSTRAP = 0,
      INITIAL_STATUS_V3 = 1,
      FULL = 2,
      RECENT = 3,
      PUSH_NAME = 4,
      NON_BLOCKING_DATA = 5,
      ON_DEMAND = 6
    }
  }
  interface IHistorySyncMsg {
    message?: (proto.IWebMessageInfo | null);
    msgOrderId?: (number | Long$1 | null);
  }
  class HistorySyncMsg implements IHistorySyncMsg {
    constructor(p?: proto.IHistorySyncMsg);
    public message?: (proto.IWebMessageInfo | null);
    public msgOrderId?: (number | Long$1 | null);
    public static create(properties?: proto.IHistorySyncMsg): proto.HistorySyncMsg;
    public static encode(m: proto.IHistorySyncMsg, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.HistorySyncMsg;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.HistorySyncMsg;
    public static toObject(m: proto.HistorySyncMsg, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IHydratedTemplateButton {
    index?: (number | null);
    quickReplyButton?: (proto.HydratedTemplateButton.IHydratedQuickReplyButton | null);
    urlButton?: (proto.HydratedTemplateButton.IHydratedURLButton | null);
    callButton?: (proto.HydratedTemplateButton.IHydratedCallButton | null);
  }
  class HydratedTemplateButton implements IHydratedTemplateButton {
    constructor(p?: proto.IHydratedTemplateButton);
    public index?: (number | null);
    public quickReplyButton?: (proto.HydratedTemplateButton.IHydratedQuickReplyButton | null);
    public urlButton?: (proto.HydratedTemplateButton.IHydratedURLButton | null);
    public callButton?: (proto.HydratedTemplateButton.IHydratedCallButton | null);
    public hydratedButton?: ("quickReplyButton" | "urlButton" | "callButton");
    public static create(properties?: proto.IHydratedTemplateButton): proto.HydratedTemplateButton;
    public static encode(m: proto.IHydratedTemplateButton, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.HydratedTemplateButton;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.HydratedTemplateButton;
    public static toObject(m: proto.HydratedTemplateButton, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace HydratedTemplateButton {
    interface IHydratedCallButton {
      displayText?: (string | null);
      phoneNumber?: (string | null);
    }
    class HydratedCallButton implements IHydratedCallButton {
      constructor(p?: proto.HydratedTemplateButton.IHydratedCallButton);
      public displayText?: (string | null);
      public phoneNumber?: (string | null);
      public static create(properties?: proto.HydratedTemplateButton.IHydratedCallButton): proto.HydratedTemplateButton.HydratedCallButton;
      public static encode(m: proto.HydratedTemplateButton.IHydratedCallButton, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.HydratedTemplateButton.HydratedCallButton;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.HydratedTemplateButton.HydratedCallButton;
      public static toObject(m: proto.HydratedTemplateButton.HydratedCallButton, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IHydratedQuickReplyButton {
      displayText?: (string | null);
      id?: (string | null);
    }
    class HydratedQuickReplyButton implements IHydratedQuickReplyButton {
      constructor(p?: proto.HydratedTemplateButton.IHydratedQuickReplyButton);
      public displayText?: (string | null);
      public id?: (string | null);
      public static create(properties?: proto.HydratedTemplateButton.IHydratedQuickReplyButton): proto.HydratedTemplateButton.HydratedQuickReplyButton;
      public static encode(m: proto.HydratedTemplateButton.IHydratedQuickReplyButton, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.HydratedTemplateButton.HydratedQuickReplyButton;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.HydratedTemplateButton.HydratedQuickReplyButton;
      public static toObject(m: proto.HydratedTemplateButton.HydratedQuickReplyButton, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IHydratedURLButton {
      displayText?: (string | null);
      url?: (string | null);
      consentedUsersUrl?: (string | null);
      webviewPresentation?: (proto.HydratedTemplateButton.HydratedURLButton.WebviewPresentationType | null);
    }
    class HydratedURLButton implements IHydratedURLButton {
      constructor(p?: proto.HydratedTemplateButton.IHydratedURLButton);
      public displayText?: (string | null);
      public url?: (string | null);
      public consentedUsersUrl?: (string | null);
      public webviewPresentation?: (proto.HydratedTemplateButton.HydratedURLButton.WebviewPresentationType | null);
      public static create(properties?: proto.HydratedTemplateButton.IHydratedURLButton): proto.HydratedTemplateButton.HydratedURLButton;
      public static encode(m: proto.HydratedTemplateButton.IHydratedURLButton, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.HydratedTemplateButton.HydratedURLButton;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.HydratedTemplateButton.HydratedURLButton;
      public static toObject(m: proto.HydratedTemplateButton.HydratedURLButton, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace HydratedURLButton {
      enum WebviewPresentationType {
        FULL = 1,
        TALL = 2,
        COMPACT = 3
      }
    }
  }
  interface IIdentityKeyPairStructure {
    publicKey?: (Uint8Array | null);
    privateKey?: (Uint8Array | null);
  }
  class IdentityKeyPairStructure implements IIdentityKeyPairStructure {
    constructor(p?: proto.IIdentityKeyPairStructure);
    public publicKey?: (Uint8Array | null);
    public privateKey?: (Uint8Array | null);
    public static create(properties?: proto.IIdentityKeyPairStructure): proto.IdentityKeyPairStructure;
    public static encode(m: proto.IIdentityKeyPairStructure, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.IdentityKeyPairStructure;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.IdentityKeyPairStructure;
    public static toObject(m: proto.IdentityKeyPairStructure, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IInThreadSurveyMetadata {
    tessaSessionId?: (string | null);
    simonSessionId?: (string | null);
    simonSurveyId?: (string | null);
    tessaRootId?: (string | null);
    requestId?: (string | null);
    tessaEvent?: (string | null);
    invitationHeaderText?: (string | null);
    invitationBodyText?: (string | null);
    invitationCtaText?: (string | null);
    invitationCtaUrl?: (string | null);
    surveyTitle?: (string | null);
    questions?: (proto.InThreadSurveyMetadata.IInThreadSurveyQuestion[] | null);
    surveyContinueButtonText?: (string | null);
    surveySubmitButtonText?: (string | null);
    privacyStatementFull?: (string | null);
    privacyStatementParts?: (proto.InThreadSurveyMetadata.IInThreadSurveyPrivacyStatementPart[] | null);
    feedbackToastText?: (string | null);
  }
  class InThreadSurveyMetadata implements IInThreadSurveyMetadata {
    constructor(p?: proto.IInThreadSurveyMetadata);
    public tessaSessionId?: (string | null);
    public simonSessionId?: (string | null);
    public simonSurveyId?: (string | null);
    public tessaRootId?: (string | null);
    public requestId?: (string | null);
    public tessaEvent?: (string | null);
    public invitationHeaderText?: (string | null);
    public invitationBodyText?: (string | null);
    public invitationCtaText?: (string | null);
    public invitationCtaUrl?: (string | null);
    public surveyTitle?: (string | null);
    public questions: proto.InThreadSurveyMetadata.IInThreadSurveyQuestion[];
    public surveyContinueButtonText?: (string | null);
    public surveySubmitButtonText?: (string | null);
    public privacyStatementFull?: (string | null);
    public privacyStatementParts: proto.InThreadSurveyMetadata.IInThreadSurveyPrivacyStatementPart[];
    public feedbackToastText?: (string | null);
    public static create(properties?: proto.IInThreadSurveyMetadata): proto.InThreadSurveyMetadata;
    public static encode(m: proto.IInThreadSurveyMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.InThreadSurveyMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.InThreadSurveyMetadata;
    public static toObject(m: proto.InThreadSurveyMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace InThreadSurveyMetadata {
    interface IInThreadSurveyOption {
      stringValue?: (string | null);
      numericValue?: (number | null);
      textTranslated?: (string | null);
    }
    class InThreadSurveyOption implements IInThreadSurveyOption {
      constructor(p?: proto.InThreadSurveyMetadata.IInThreadSurveyOption);
      public stringValue?: (string | null);
      public numericValue?: (number | null);
      public textTranslated?: (string | null);
      public static create(properties?: proto.InThreadSurveyMetadata.IInThreadSurveyOption): proto.InThreadSurveyMetadata.InThreadSurveyOption;
      public static encode(m: proto.InThreadSurveyMetadata.IInThreadSurveyOption, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.InThreadSurveyMetadata.InThreadSurveyOption;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.InThreadSurveyMetadata.InThreadSurveyOption;
      public static toObject(m: proto.InThreadSurveyMetadata.InThreadSurveyOption, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IInThreadSurveyPrivacyStatementPart {
      text?: (string | null);
      url?: (string | null);
    }
    class InThreadSurveyPrivacyStatementPart implements IInThreadSurveyPrivacyStatementPart {
      constructor(p?: proto.InThreadSurveyMetadata.IInThreadSurveyPrivacyStatementPart);
      public text?: (string | null);
      public url?: (string | null);
      public static create(properties?: proto.InThreadSurveyMetadata.IInThreadSurveyPrivacyStatementPart): proto.InThreadSurveyMetadata.InThreadSurveyPrivacyStatementPart;
      public static encode(m: proto.InThreadSurveyMetadata.IInThreadSurveyPrivacyStatementPart, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.InThreadSurveyMetadata.InThreadSurveyPrivacyStatementPart;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.InThreadSurveyMetadata.InThreadSurveyPrivacyStatementPart;
      public static toObject(m: proto.InThreadSurveyMetadata.InThreadSurveyPrivacyStatementPart, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IInThreadSurveyQuestion {
      questionText?: (string | null);
      questionId?: (string | null);
      questionOptions?: (proto.InThreadSurveyMetadata.IInThreadSurveyOption[] | null);
    }
    class InThreadSurveyQuestion implements IInThreadSurveyQuestion {
      constructor(p?: proto.InThreadSurveyMetadata.IInThreadSurveyQuestion);
      public questionText?: (string | null);
      public questionId?: (string | null);
      public questionOptions: proto.InThreadSurveyMetadata.IInThreadSurveyOption[];
      public static create(properties?: proto.InThreadSurveyMetadata.IInThreadSurveyQuestion): proto.InThreadSurveyMetadata.InThreadSurveyQuestion;
      public static encode(m: proto.InThreadSurveyMetadata.IInThreadSurveyQuestion, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.InThreadSurveyMetadata.InThreadSurveyQuestion;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.InThreadSurveyMetadata.InThreadSurveyQuestion;
      public static toObject(m: proto.InThreadSurveyMetadata.InThreadSurveyQuestion, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IInteractiveAnnotation {
    polygonVertices?: (proto.IPoint[] | null);
    shouldSkipConfirmation?: (boolean | null);
    embeddedContent?: (proto.IEmbeddedContent | null);
    statusLinkType?: (proto.InteractiveAnnotation.StatusLinkType | null);
    location?: (proto.ILocation | null);
    newsletter?: (proto.ContextInfo.IForwardedNewsletterMessageInfo | null);
    embeddedAction?: (boolean | null);
    tapAction?: (proto.ITapLinkAction | null);
  }
  class InteractiveAnnotation implements IInteractiveAnnotation {
    constructor(p?: proto.IInteractiveAnnotation);
    public polygonVertices: proto.IPoint[];
    public shouldSkipConfirmation?: (boolean | null);
    public embeddedContent?: (proto.IEmbeddedContent | null);
    public statusLinkType?: (proto.InteractiveAnnotation.StatusLinkType | null);
    public location?: (proto.ILocation | null);
    public newsletter?: (proto.ContextInfo.IForwardedNewsletterMessageInfo | null);
    public embeddedAction?: (boolean | null);
    public tapAction?: (proto.ITapLinkAction | null);
    public action?: ("location" | "newsletter" | "embeddedAction" | "tapAction");
    public static create(properties?: proto.IInteractiveAnnotation): proto.InteractiveAnnotation;
    public static encode(m: proto.IInteractiveAnnotation, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.InteractiveAnnotation;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.InteractiveAnnotation;
    public static toObject(m: proto.InteractiveAnnotation, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace InteractiveAnnotation {
    enum StatusLinkType {
      RASTERIZED_LINK_PREVIEW = 1,
      RASTERIZED_LINK_TRUNCATED = 2,
      RASTERIZED_LINK_FULL_URL = 3
    }
  }
  interface IInteractiveMessageAdditionalMetadata {
    isGalaxyFlowCompleted?: (boolean | null);
  }
  class InteractiveMessageAdditionalMetadata implements IInteractiveMessageAdditionalMetadata {
    constructor(p?: proto.IInteractiveMessageAdditionalMetadata);
    public isGalaxyFlowCompleted?: (boolean | null);
    public static create(properties?: proto.IInteractiveMessageAdditionalMetadata): proto.InteractiveMessageAdditionalMetadata;
    public static encode(m: proto.IInteractiveMessageAdditionalMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.InteractiveMessageAdditionalMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.InteractiveMessageAdditionalMetadata;
    public static toObject(m: proto.InteractiveMessageAdditionalMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IKeepInChat {
    keepType?: (proto.KeepType | null);
    serverTimestamp?: (number | Long$1 | null);
    key?: (proto.IMessageKey | null);
    deviceJid?: (string | null);
    clientTimestampMs?: (number | Long$1 | null);
    serverTimestampMs?: (number | Long$1 | null);
  }
  class KeepInChat implements IKeepInChat {
    constructor(p?: proto.IKeepInChat);
    public keepType?: (proto.KeepType | null);
    public serverTimestamp?: (number | Long$1 | null);
    public key?: (proto.IMessageKey | null);
    public deviceJid?: (string | null);
    public clientTimestampMs?: (number | Long$1 | null);
    public serverTimestampMs?: (number | Long$1 | null);
    public static create(properties?: proto.IKeepInChat): proto.KeepInChat;
    public static encode(m: proto.IKeepInChat, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.KeepInChat;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.KeepInChat;
    public static toObject(m: proto.KeepInChat, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  enum KeepType {
    UNKNOWN = 0,
    KEEP_FOR_ALL = 1,
    UNDO_KEEP_FOR_ALL = 2
  }
  interface IKeyExchangeMessage {
    id?: (number | null);
    baseKey?: (Uint8Array | null);
    ratchetKey?: (Uint8Array | null);
    identityKey?: (Uint8Array | null);
    baseKeySignature?: (Uint8Array | null);
  }
  class KeyExchangeMessage implements IKeyExchangeMessage {
    constructor(p?: proto.IKeyExchangeMessage);
    public id?: (number | null);
    public baseKey?: (Uint8Array | null);
    public ratchetKey?: (Uint8Array | null);
    public identityKey?: (Uint8Array | null);
    public baseKeySignature?: (Uint8Array | null);
    public static create(properties?: proto.IKeyExchangeMessage): proto.KeyExchangeMessage;
    public static encode(m: proto.IKeyExchangeMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.KeyExchangeMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.KeyExchangeMessage;
    public static toObject(m: proto.KeyExchangeMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IKeyId {
    id?: (Uint8Array | null);
  }
  class KeyId implements IKeyId {
    constructor(p?: proto.IKeyId);
    public id?: (Uint8Array | null);
    public static create(properties?: proto.IKeyId): proto.KeyId;
    public static encode(m: proto.IKeyId, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.KeyId;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.KeyId;
    public static toObject(m: proto.KeyId, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ILIDMigrationMapping {
    pn?: (number | Long$1 | null);
    assignedLid?: (number | Long$1 | null);
    latestLid?: (number | Long$1 | null);
  }
  class LIDMigrationMapping implements ILIDMigrationMapping {
    constructor(p?: proto.ILIDMigrationMapping);
    public pn: (number | Long$1);
    public assignedLid: (number | Long$1);
    public latestLid?: (number | Long$1 | null);
    public static create(properties?: proto.ILIDMigrationMapping): proto.LIDMigrationMapping;
    public static encode(m: proto.ILIDMigrationMapping, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.LIDMigrationMapping;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.LIDMigrationMapping;
    public static toObject(m: proto.LIDMigrationMapping, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ILIDMigrationMappingSyncMessage {
    encodedMappingPayload?: (Uint8Array | null);
  }
  class LIDMigrationMappingSyncMessage implements ILIDMigrationMappingSyncMessage {
    constructor(p?: proto.ILIDMigrationMappingSyncMessage);
    public encodedMappingPayload?: (Uint8Array | null);
    public static create(properties?: proto.ILIDMigrationMappingSyncMessage): proto.LIDMigrationMappingSyncMessage;
    public static encode(m: proto.ILIDMigrationMappingSyncMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.LIDMigrationMappingSyncMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.LIDMigrationMappingSyncMessage;
    public static toObject(m: proto.LIDMigrationMappingSyncMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ILIDMigrationMappingSyncPayload {
    pnToLidMappings?: (proto.ILIDMigrationMapping[] | null);
    chatDbMigrationTimestamp?: (number | Long$1 | null);
  }
  class LIDMigrationMappingSyncPayload implements ILIDMigrationMappingSyncPayload {
    constructor(p?: proto.ILIDMigrationMappingSyncPayload);
    public pnToLidMappings: proto.ILIDMigrationMapping[];
    public chatDbMigrationTimestamp?: (number | Long$1 | null);
    public static create(properties?: proto.ILIDMigrationMappingSyncPayload): proto.LIDMigrationMappingSyncPayload;
    public static encode(m: proto.ILIDMigrationMappingSyncPayload, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.LIDMigrationMappingSyncPayload;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.LIDMigrationMappingSyncPayload;
    public static toObject(m: proto.LIDMigrationMappingSyncPayload, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ILegacyMessage {
    eventResponseMessage?: (proto.Message.IEventResponseMessage | null);
    pollVote?: (proto.Message.IPollVoteMessage | null);
  }
  class LegacyMessage implements ILegacyMessage {
    constructor(p?: proto.ILegacyMessage);
    public eventResponseMessage?: (proto.Message.IEventResponseMessage | null);
    public pollVote?: (proto.Message.IPollVoteMessage | null);
    public static create(properties?: proto.ILegacyMessage): proto.LegacyMessage;
    public static encode(m: proto.ILegacyMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.LegacyMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.LegacyMessage;
    public static toObject(m: proto.LegacyMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ILimitSharing {
    sharingLimited?: (boolean | null);
    trigger?: (proto.LimitSharing.TriggerType | null);
    limitSharingSettingTimestamp?: (number | Long$1 | null);
    initiatedByMe?: (boolean | null);
  }
  class LimitSharing implements ILimitSharing {
    constructor(p?: proto.ILimitSharing);
    public sharingLimited?: (boolean | null);
    public trigger?: (proto.LimitSharing.TriggerType | null);
    public limitSharingSettingTimestamp?: (number | Long$1 | null);
    public initiatedByMe?: (boolean | null);
    public static create(properties?: proto.ILimitSharing): proto.LimitSharing;
    public static encode(m: proto.ILimitSharing, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.LimitSharing;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.LimitSharing;
    public static toObject(m: proto.LimitSharing, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace LimitSharing {
    enum TriggerType {
      UNKNOWN = 0,
      CHAT_SETTING = 1,
      BIZ_SUPPORTS_FB_HOSTING = 2,
      UNKNOWN_GROUP = 3
    }
  }
  interface ILocalizedName {
    lg?: (string | null);
    lc?: (string | null);
    verifiedName?: (string | null);
  }
  class LocalizedName implements ILocalizedName {
    constructor(p?: proto.ILocalizedName);
    public lg?: (string | null);
    public lc?: (string | null);
    public verifiedName?: (string | null);
    public static create(properties?: proto.ILocalizedName): proto.LocalizedName;
    public static encode(m: proto.ILocalizedName, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.LocalizedName;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.LocalizedName;
    public static toObject(m: proto.LocalizedName, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ILocation {
    degreesLatitude?: (number | null);
    degreesLongitude?: (number | null);
    name?: (string | null);
  }
  class Location implements ILocation {
    constructor(p?: proto.ILocation);
    public degreesLatitude?: (number | null);
    public degreesLongitude?: (number | null);
    public name?: (string | null);
    public static create(properties?: proto.ILocation): proto.Location;
    public static encode(m: proto.ILocation, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Location;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Location;
    public static toObject(m: proto.Location, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IMediaData {
    localPath?: (string | null);
  }
  class MediaData implements IMediaData {
    constructor(p?: proto.IMediaData);
    public localPath?: (string | null);
    public static create(properties?: proto.IMediaData): proto.MediaData;
    public static encode(m: proto.IMediaData, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MediaData;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MediaData;
    public static toObject(m: proto.MediaData, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IMediaNotifyMessage {
    expressPathUrl?: (string | null);
    fileEncSha256?: (Uint8Array | null);
    fileLength?: (number | Long$1 | null);
  }
  class MediaNotifyMessage implements IMediaNotifyMessage {
    constructor(p?: proto.IMediaNotifyMessage);
    public expressPathUrl?: (string | null);
    public fileEncSha256?: (Uint8Array | null);
    public fileLength?: (number | Long$1 | null);
    public static create(properties?: proto.IMediaNotifyMessage): proto.MediaNotifyMessage;
    public static encode(m: proto.IMediaNotifyMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MediaNotifyMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MediaNotifyMessage;
    public static toObject(m: proto.MediaNotifyMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IMediaRetryNotification {
    stanzaId?: (string | null);
    directPath?: (string | null);
    result?: (proto.MediaRetryNotification.ResultType | null);
    messageSecret?: (Uint8Array | null);
  }
  class MediaRetryNotification implements IMediaRetryNotification {
    constructor(p?: proto.IMediaRetryNotification);
    public stanzaId?: (string | null);
    public directPath?: (string | null);
    public result?: (proto.MediaRetryNotification.ResultType | null);
    public messageSecret?: (Uint8Array | null);
    public static create(properties?: proto.IMediaRetryNotification): proto.MediaRetryNotification;
    public static encode(m: proto.IMediaRetryNotification, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MediaRetryNotification;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MediaRetryNotification;
    public static toObject(m: proto.MediaRetryNotification, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace MediaRetryNotification {
    enum ResultType {
      GENERAL_ERROR = 0,
      SUCCESS = 1,
      NOT_FOUND = 2,
      DECRYPTION_ERROR = 3
    }
  }
  enum MediaVisibility {
    DEFAULT = 0,
    OFF = 1,
    ON = 2
  }
  interface IMemberLabel {
    label?: (string | null);
    labelTimestamp?: (number | Long$1 | null);
  }
  class MemberLabel implements IMemberLabel {
    constructor(p?: proto.IMemberLabel);
    public label?: (string | null);
    public labelTimestamp?: (number | Long$1 | null);
    public static create(properties?: proto.IMemberLabel): proto.MemberLabel;
    public static encode(m: proto.IMemberLabel, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MemberLabel;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MemberLabel;
    public static toObject(m: proto.MemberLabel, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IMessage {
    conversation?: (string | null);
    senderKeyDistributionMessage?: (proto.Message.ISenderKeyDistributionMessage | null);
    imageMessage?: (proto.Message.IImageMessage | null);
    contactMessage?: (proto.Message.IContactMessage | null);
    locationMessage?: (proto.Message.ILocationMessage | null);
    extendedTextMessage?: (proto.Message.IExtendedTextMessage | null);
    documentMessage?: (proto.Message.IDocumentMessage | null);
    audioMessage?: (proto.Message.IAudioMessage | null);
    videoMessage?: (proto.Message.IVideoMessage | null);
    call?: (proto.Message.ICall | null);
    chat?: (proto.Message.IChat | null);
    protocolMessage?: (proto.Message.IProtocolMessage | null);
    contactsArrayMessage?: (proto.Message.IContactsArrayMessage | null);
    highlyStructuredMessage?: (proto.Message.IHighlyStructuredMessage | null);
    fastRatchetKeySenderKeyDistributionMessage?: (proto.Message.ISenderKeyDistributionMessage | null);
    sendPaymentMessage?: (proto.Message.ISendPaymentMessage | null);
    liveLocationMessage?: (proto.Message.ILiveLocationMessage | null);
    requestPaymentMessage?: (proto.Message.IRequestPaymentMessage | null);
    declinePaymentRequestMessage?: (proto.Message.IDeclinePaymentRequestMessage | null);
    cancelPaymentRequestMessage?: (proto.Message.ICancelPaymentRequestMessage | null);
    templateMessage?: (proto.Message.ITemplateMessage | null);
    stickerMessage?: (proto.Message.IStickerMessage | null);
    groupInviteMessage?: (proto.Message.IGroupInviteMessage | null);
    templateButtonReplyMessage?: (proto.Message.ITemplateButtonReplyMessage | null);
    productMessage?: (proto.Message.IProductMessage | null);
    deviceSentMessage?: (proto.Message.IDeviceSentMessage | null);
    messageContextInfo?: (proto.IMessageContextInfo | null);
    listMessage?: (proto.Message.IListMessage | null);
    viewOnceMessage?: (proto.Message.IFutureProofMessage | null);
    orderMessage?: (proto.Message.IOrderMessage | null);
    listResponseMessage?: (proto.Message.IListResponseMessage | null);
    ephemeralMessage?: (proto.Message.IFutureProofMessage | null);
    invoiceMessage?: (proto.Message.IInvoiceMessage | null);
    buttonsMessage?: (proto.Message.IButtonsMessage | null);
    buttonsResponseMessage?: (proto.Message.IButtonsResponseMessage | null);
    paymentInviteMessage?: (proto.Message.IPaymentInviteMessage | null);
    interactiveMessage?: (proto.Message.IInteractiveMessage | null);
    reactionMessage?: (proto.Message.IReactionMessage | null);
    stickerSyncRmrMessage?: (proto.Message.IStickerSyncRMRMessage | null);
    interactiveResponseMessage?: (proto.Message.IInteractiveResponseMessage | null);
    pollCreationMessage?: (proto.Message.IPollCreationMessage | null);
    pollUpdateMessage?: (proto.Message.IPollUpdateMessage | null);
    keepInChatMessage?: (proto.Message.IKeepInChatMessage | null);
    documentWithCaptionMessage?: (proto.Message.IFutureProofMessage | null);
    requestPhoneNumberMessage?: (proto.Message.IRequestPhoneNumberMessage | null);
    viewOnceMessageV2?: (proto.Message.IFutureProofMessage | null);
    encReactionMessage?: (proto.Message.IEncReactionMessage | null);
    editedMessage?: (proto.Message.IFutureProofMessage | null);
    viewOnceMessageV2Extension?: (proto.Message.IFutureProofMessage | null);
    pollCreationMessageV2?: (proto.Message.IPollCreationMessage | null);
    scheduledCallCreationMessage?: (proto.Message.IScheduledCallCreationMessage | null);
    groupMentionedMessage?: (proto.Message.IFutureProofMessage | null);
    pinInChatMessage?: (proto.Message.IPinInChatMessage | null);
    pollCreationMessageV3?: (proto.Message.IPollCreationMessage | null);
    scheduledCallEditMessage?: (proto.Message.IScheduledCallEditMessage | null);
    ptvMessage?: (proto.Message.IVideoMessage | null);
    botInvokeMessage?: (proto.Message.IFutureProofMessage | null);
    callLogMesssage?: (proto.Message.ICallLogMessage | null);
    messageHistoryBundle?: (proto.Message.IMessageHistoryBundle | null);
    encCommentMessage?: (proto.Message.IEncCommentMessage | null);
    bcallMessage?: (proto.Message.IBCallMessage | null);
    lottieStickerMessage?: (proto.Message.IFutureProofMessage | null);
    eventMessage?: (proto.Message.IEventMessage | null);
    encEventResponseMessage?: (proto.Message.IEncEventResponseMessage | null);
    commentMessage?: (proto.Message.ICommentMessage | null);
    newsletterAdminInviteMessage?: (proto.Message.INewsletterAdminInviteMessage | null);
    placeholderMessage?: (proto.Message.IPlaceholderMessage | null);
    secretEncryptedMessage?: (proto.Message.ISecretEncryptedMessage | null);
    albumMessage?: (proto.Message.IAlbumMessage | null);
    eventCoverImage?: (proto.Message.IFutureProofMessage | null);
    stickerPackMessage?: (proto.Message.IStickerPackMessage | null);
    statusMentionMessage?: (proto.Message.IFutureProofMessage | null);
    pollResultSnapshotMessage?: (proto.Message.IPollResultSnapshotMessage | null);
    pollCreationOptionImageMessage?: (proto.Message.IFutureProofMessage | null);
    associatedChildMessage?: (proto.Message.IFutureProofMessage | null);
    groupStatusMentionMessage?: (proto.Message.IFutureProofMessage | null);
    pollCreationMessageV4?: (proto.Message.IFutureProofMessage | null);
    statusAddYours?: (proto.Message.IFutureProofMessage | null);
    groupStatusMessage?: (proto.Message.IFutureProofMessage | null);
    richResponseMessage?: (proto.IAIRichResponseMessage | null);
    statusNotificationMessage?: (proto.Message.IStatusNotificationMessage | null);
    limitSharingMessage?: (proto.Message.IFutureProofMessage | null);
    botTaskMessage?: (proto.Message.IFutureProofMessage | null);
    questionMessage?: (proto.Message.IFutureProofMessage | null);
    messageHistoryNotice?: (proto.Message.IMessageHistoryNotice | null);
    groupStatusMessageV2?: (proto.Message.IFutureProofMessage | null);
    botForwardedMessage?: (proto.Message.IFutureProofMessage | null);
    statusQuestionAnswerMessage?: (proto.Message.IStatusQuestionAnswerMessage | null);
    questionReplyMessage?: (proto.Message.IFutureProofMessage | null);
    questionResponseMessage?: (proto.Message.IQuestionResponseMessage | null);
    statusQuotedMessage?: (proto.Message.IStatusQuotedMessage | null);
    statusStickerInteractionMessage?: (proto.Message.IStatusStickerInteractionMessage | null);
    pollCreationMessageV5?: (proto.Message.IPollCreationMessage | null);
    newsletterFollowerInviteMessageV2?: (proto.Message.INewsletterFollowerInviteMessage | null);
    pollResultSnapshotMessageV3?: (proto.Message.IPollResultSnapshotMessage | null);
  }
  class Message implements IMessage {
    constructor(p?: proto.IMessage);
    public conversation?: (string | null);
    public senderKeyDistributionMessage?: (proto.Message.ISenderKeyDistributionMessage | null);
    public imageMessage?: (proto.Message.IImageMessage | null);
    public contactMessage?: (proto.Message.IContactMessage | null);
    public locationMessage?: (proto.Message.ILocationMessage | null);
    public extendedTextMessage?: (proto.Message.IExtendedTextMessage | null);
    public documentMessage?: (proto.Message.IDocumentMessage | null);
    public audioMessage?: (proto.Message.IAudioMessage | null);
    public videoMessage?: (proto.Message.IVideoMessage | null);
    public call?: (proto.Message.ICall | null);
    public chat?: (proto.Message.IChat | null);
    public protocolMessage?: (proto.Message.IProtocolMessage | null);
    public contactsArrayMessage?: (proto.Message.IContactsArrayMessage | null);
    public highlyStructuredMessage?: (proto.Message.IHighlyStructuredMessage | null);
    public fastRatchetKeySenderKeyDistributionMessage?: (proto.Message.ISenderKeyDistributionMessage | null);
    public sendPaymentMessage?: (proto.Message.ISendPaymentMessage | null);
    public liveLocationMessage?: (proto.Message.ILiveLocationMessage | null);
    public requestPaymentMessage?: (proto.Message.IRequestPaymentMessage | null);
    public declinePaymentRequestMessage?: (proto.Message.IDeclinePaymentRequestMessage | null);
    public cancelPaymentRequestMessage?: (proto.Message.ICancelPaymentRequestMessage | null);
    public templateMessage?: (proto.Message.ITemplateMessage | null);
    public stickerMessage?: (proto.Message.IStickerMessage | null);
    public groupInviteMessage?: (proto.Message.IGroupInviteMessage | null);
    public templateButtonReplyMessage?: (proto.Message.ITemplateButtonReplyMessage | null);
    public productMessage?: (proto.Message.IProductMessage | null);
    public deviceSentMessage?: (proto.Message.IDeviceSentMessage | null);
    public messageContextInfo?: (proto.IMessageContextInfo | null);
    public listMessage?: (proto.Message.IListMessage | null);
    public viewOnceMessage?: (proto.Message.IFutureProofMessage | null);
    public orderMessage?: (proto.Message.IOrderMessage | null);
    public listResponseMessage?: (proto.Message.IListResponseMessage | null);
    public ephemeralMessage?: (proto.Message.IFutureProofMessage | null);
    public invoiceMessage?: (proto.Message.IInvoiceMessage | null);
    public buttonsMessage?: (proto.Message.IButtonsMessage | null);
    public buttonsResponseMessage?: (proto.Message.IButtonsResponseMessage | null);
    public paymentInviteMessage?: (proto.Message.IPaymentInviteMessage | null);
    public interactiveMessage?: (proto.Message.IInteractiveMessage | null);
    public reactionMessage?: (proto.Message.IReactionMessage | null);
    public stickerSyncRmrMessage?: (proto.Message.IStickerSyncRMRMessage | null);
    public interactiveResponseMessage?: (proto.Message.IInteractiveResponseMessage | null);
    public pollCreationMessage?: (proto.Message.IPollCreationMessage | null);
    public pollUpdateMessage?: (proto.Message.IPollUpdateMessage | null);
    public keepInChatMessage?: (proto.Message.IKeepInChatMessage | null);
    public documentWithCaptionMessage?: (proto.Message.IFutureProofMessage | null);
    public requestPhoneNumberMessage?: (proto.Message.IRequestPhoneNumberMessage | null);
    public viewOnceMessageV2?: (proto.Message.IFutureProofMessage | null);
    public encReactionMessage?: (proto.Message.IEncReactionMessage | null);
    public editedMessage?: (proto.Message.IFutureProofMessage | null);
    public viewOnceMessageV2Extension?: (proto.Message.IFutureProofMessage | null);
    public pollCreationMessageV2?: (proto.Message.IPollCreationMessage | null);
    public scheduledCallCreationMessage?: (proto.Message.IScheduledCallCreationMessage | null);
    public groupMentionedMessage?: (proto.Message.IFutureProofMessage | null);
    public pinInChatMessage?: (proto.Message.IPinInChatMessage | null);
    public pollCreationMessageV3?: (proto.Message.IPollCreationMessage | null);
    public scheduledCallEditMessage?: (proto.Message.IScheduledCallEditMessage | null);
    public ptvMessage?: (proto.Message.IVideoMessage | null);
    public botInvokeMessage?: (proto.Message.IFutureProofMessage | null);
    public callLogMesssage?: (proto.Message.ICallLogMessage | null);
    public messageHistoryBundle?: (proto.Message.IMessageHistoryBundle | null);
    public encCommentMessage?: (proto.Message.IEncCommentMessage | null);
    public bcallMessage?: (proto.Message.IBCallMessage | null);
    public lottieStickerMessage?: (proto.Message.IFutureProofMessage | null);
    public eventMessage?: (proto.Message.IEventMessage | null);
    public encEventResponseMessage?: (proto.Message.IEncEventResponseMessage | null);
    public commentMessage?: (proto.Message.ICommentMessage | null);
    public newsletterAdminInviteMessage?: (proto.Message.INewsletterAdminInviteMessage | null);
    public placeholderMessage?: (proto.Message.IPlaceholderMessage | null);
    public secretEncryptedMessage?: (proto.Message.ISecretEncryptedMessage | null);
    public albumMessage?: (proto.Message.IAlbumMessage | null);
    public eventCoverImage?: (proto.Message.IFutureProofMessage | null);
    public stickerPackMessage?: (proto.Message.IStickerPackMessage | null);
    public statusMentionMessage?: (proto.Message.IFutureProofMessage | null);
    public pollResultSnapshotMessage?: (proto.Message.IPollResultSnapshotMessage | null);
    public pollCreationOptionImageMessage?: (proto.Message.IFutureProofMessage | null);
    public associatedChildMessage?: (proto.Message.IFutureProofMessage | null);
    public groupStatusMentionMessage?: (proto.Message.IFutureProofMessage | null);
    public pollCreationMessageV4?: (proto.Message.IFutureProofMessage | null);
    public statusAddYours?: (proto.Message.IFutureProofMessage | null);
    public groupStatusMessage?: (proto.Message.IFutureProofMessage | null);
    public richResponseMessage?: (proto.IAIRichResponseMessage | null);
    public statusNotificationMessage?: (proto.Message.IStatusNotificationMessage | null);
    public limitSharingMessage?: (proto.Message.IFutureProofMessage | null);
    public botTaskMessage?: (proto.Message.IFutureProofMessage | null);
    public questionMessage?: (proto.Message.IFutureProofMessage | null);
    public messageHistoryNotice?: (proto.Message.IMessageHistoryNotice | null);
    public groupStatusMessageV2?: (proto.Message.IFutureProofMessage | null);
    public botForwardedMessage?: (proto.Message.IFutureProofMessage | null);
    public statusQuestionAnswerMessage?: (proto.Message.IStatusQuestionAnswerMessage | null);
    public questionReplyMessage?: (proto.Message.IFutureProofMessage | null);
    public questionResponseMessage?: (proto.Message.IQuestionResponseMessage | null);
    public statusQuotedMessage?: (proto.Message.IStatusQuotedMessage | null);
    public statusStickerInteractionMessage?: (proto.Message.IStatusStickerInteractionMessage | null);
    public pollCreationMessageV5?: (proto.Message.IPollCreationMessage | null);
    public newsletterFollowerInviteMessageV2?: (proto.Message.INewsletterFollowerInviteMessage | null);
    public pollResultSnapshotMessageV3?: (proto.Message.IPollResultSnapshotMessage | null);
    public static create(properties?: proto.IMessage): proto.Message;
    public static encode(m: proto.IMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Message;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Message;
    public static toObject(m: proto.Message, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace Message {
    interface IAlbumMessage {
      expectedImageCount?: (number | null);
      expectedVideoCount?: (number | null);
      contextInfo?: (proto.IContextInfo | null);
    }
    class AlbumMessage implements IAlbumMessage {
      constructor(p?: proto.Message.IAlbumMessage);
      public expectedImageCount?: (number | null);
      public expectedVideoCount?: (number | null);
      public contextInfo?: (proto.IContextInfo | null);
      public static create(properties?: proto.Message.IAlbumMessage): proto.Message.AlbumMessage;
      public static encode(m: proto.Message.IAlbumMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.AlbumMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.AlbumMessage;
      public static toObject(m: proto.Message.AlbumMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAppStateFatalExceptionNotification {
      collectionNames?: (string[] | null);
      timestamp?: (number | Long$1 | null);
    }
    class AppStateFatalExceptionNotification implements IAppStateFatalExceptionNotification {
      constructor(p?: proto.Message.IAppStateFatalExceptionNotification);
      public collectionNames: string[];
      public timestamp?: (number | Long$1 | null);
      public static create(properties?: proto.Message.IAppStateFatalExceptionNotification): proto.Message.AppStateFatalExceptionNotification;
      public static encode(m: proto.Message.IAppStateFatalExceptionNotification, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.AppStateFatalExceptionNotification;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.AppStateFatalExceptionNotification;
      public static toObject(m: proto.Message.AppStateFatalExceptionNotification, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAppStateSyncKey {
      keyId?: (proto.Message.IAppStateSyncKeyId | null);
      keyData?: (proto.Message.IAppStateSyncKeyData | null);
    }
    class AppStateSyncKey implements IAppStateSyncKey {
      constructor(p?: proto.Message.IAppStateSyncKey);
      public keyId?: (proto.Message.IAppStateSyncKeyId | null);
      public keyData?: (proto.Message.IAppStateSyncKeyData | null);
      public static create(properties?: proto.Message.IAppStateSyncKey): proto.Message.AppStateSyncKey;
      public static encode(m: proto.Message.IAppStateSyncKey, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.AppStateSyncKey;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.AppStateSyncKey;
      public static toObject(m: proto.Message.AppStateSyncKey, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAppStateSyncKeyData {
      keyData?: (Uint8Array | null);
      fingerprint?: (proto.Message.IAppStateSyncKeyFingerprint | null);
      timestamp?: (number | Long$1 | null);
    }
    class AppStateSyncKeyData implements IAppStateSyncKeyData {
      constructor(p?: proto.Message.IAppStateSyncKeyData);
      public keyData?: (Uint8Array | null);
      public fingerprint?: (proto.Message.IAppStateSyncKeyFingerprint | null);
      public timestamp?: (number | Long$1 | null);
      public static create(properties?: proto.Message.IAppStateSyncKeyData): proto.Message.AppStateSyncKeyData;
      public static encode(m: proto.Message.IAppStateSyncKeyData, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.AppStateSyncKeyData;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.AppStateSyncKeyData;
      public static toObject(m: proto.Message.AppStateSyncKeyData, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAppStateSyncKeyFingerprint {
      rawId?: (number | null);
      currentIndex?: (number | null);
      deviceIndexes?: (number[] | null);
    }
    class AppStateSyncKeyFingerprint implements IAppStateSyncKeyFingerprint {
      constructor(p?: proto.Message.IAppStateSyncKeyFingerprint);
      public rawId?: (number | null);
      public currentIndex?: (number | null);
      public deviceIndexes: number[];
      public static create(properties?: proto.Message.IAppStateSyncKeyFingerprint): proto.Message.AppStateSyncKeyFingerprint;
      public static encode(m: proto.Message.IAppStateSyncKeyFingerprint, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.AppStateSyncKeyFingerprint;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.AppStateSyncKeyFingerprint;
      public static toObject(m: proto.Message.AppStateSyncKeyFingerprint, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAppStateSyncKeyId {
      keyId?: (Uint8Array | null);
    }
    class AppStateSyncKeyId implements IAppStateSyncKeyId {
      constructor(p?: proto.Message.IAppStateSyncKeyId);
      public keyId?: (Uint8Array | null);
      public static create(properties?: proto.Message.IAppStateSyncKeyId): proto.Message.AppStateSyncKeyId;
      public static encode(m: proto.Message.IAppStateSyncKeyId, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.AppStateSyncKeyId;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.AppStateSyncKeyId;
      public static toObject(m: proto.Message.AppStateSyncKeyId, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAppStateSyncKeyRequest {
      keyIds?: (proto.Message.IAppStateSyncKeyId[] | null);
    }
    class AppStateSyncKeyRequest implements IAppStateSyncKeyRequest {
      constructor(p?: proto.Message.IAppStateSyncKeyRequest);
      public keyIds: proto.Message.IAppStateSyncKeyId[];
      public static create(properties?: proto.Message.IAppStateSyncKeyRequest): proto.Message.AppStateSyncKeyRequest;
      public static encode(m: proto.Message.IAppStateSyncKeyRequest, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.AppStateSyncKeyRequest;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.AppStateSyncKeyRequest;
      public static toObject(m: proto.Message.AppStateSyncKeyRequest, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAppStateSyncKeyShare {
      keys?: (proto.Message.IAppStateSyncKey[] | null);
    }
    class AppStateSyncKeyShare implements IAppStateSyncKeyShare {
      constructor(p?: proto.Message.IAppStateSyncKeyShare);
      public keys: proto.Message.IAppStateSyncKey[];
      public static create(properties?: proto.Message.IAppStateSyncKeyShare): proto.Message.AppStateSyncKeyShare;
      public static encode(m: proto.Message.IAppStateSyncKeyShare, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.AppStateSyncKeyShare;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.AppStateSyncKeyShare;
      public static toObject(m: proto.Message.AppStateSyncKeyShare, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAudioMessage {
      url?: (string | null);
      mimetype?: (string | null);
      fileSha256?: (Uint8Array | null);
      fileLength?: (number | Long$1 | null);
      seconds?: (number | null);
      ptt?: (boolean | null);
      mediaKey?: (Uint8Array | null);
      fileEncSha256?: (Uint8Array | null);
      directPath?: (string | null);
      mediaKeyTimestamp?: (number | Long$1 | null);
      contextInfo?: (proto.IContextInfo | null);
      streamingSidecar?: (Uint8Array | null);
      waveform?: (Uint8Array | null);
      backgroundArgb?: (number | null);
      viewOnce?: (boolean | null);
      accessibilityLabel?: (string | null);
      mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
    }
    class AudioMessage implements IAudioMessage {
      constructor(p?: proto.Message.IAudioMessage);
      public url?: (string | null);
      public mimetype?: (string | null);
      public fileSha256?: (Uint8Array | null);
      public fileLength?: (number | Long$1 | null);
      public seconds?: (number | null);
      public ptt?: (boolean | null);
      public mediaKey?: (Uint8Array | null);
      public fileEncSha256?: (Uint8Array | null);
      public directPath?: (string | null);
      public mediaKeyTimestamp?: (number | Long$1 | null);
      public contextInfo?: (proto.IContextInfo | null);
      public streamingSidecar?: (Uint8Array | null);
      public waveform?: (Uint8Array | null);
      public backgroundArgb?: (number | null);
      public viewOnce?: (boolean | null);
      public accessibilityLabel?: (string | null);
      public mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
      public static create(properties?: proto.Message.IAudioMessage): proto.Message.AudioMessage;
      public static encode(m: proto.Message.IAudioMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.AudioMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.AudioMessage;
      public static toObject(m: proto.Message.AudioMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IBCallMessage {
      sessionId?: (string | null);
      mediaType?: (proto.Message.BCallMessage.MediaType | null);
      masterKey?: (Uint8Array | null);
      caption?: (string | null);
    }
    class BCallMessage implements IBCallMessage {
      constructor(p?: proto.Message.IBCallMessage);
      public sessionId?: (string | null);
      public mediaType?: (proto.Message.BCallMessage.MediaType | null);
      public masterKey?: (Uint8Array | null);
      public caption?: (string | null);
      public static create(properties?: proto.Message.IBCallMessage): proto.Message.BCallMessage;
      public static encode(m: proto.Message.IBCallMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.BCallMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.BCallMessage;
      public static toObject(m: proto.Message.BCallMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace BCallMessage {
      enum MediaType {
        UNKNOWN = 0,
        AUDIO = 1,
        VIDEO = 2
      }
    }
    interface IButtonsMessage {
      contentText?: (string | null);
      footerText?: (string | null);
      contextInfo?: (proto.IContextInfo | null);
      buttons?: (proto.Message.ButtonsMessage.IButton[] | null);
      headerType?: (proto.Message.ButtonsMessage.HeaderType | null);
      text?: (string | null);
      documentMessage?: (proto.Message.IDocumentMessage | null);
      imageMessage?: (proto.Message.IImageMessage | null);
      videoMessage?: (proto.Message.IVideoMessage | null);
      locationMessage?: (proto.Message.ILocationMessage | null);
    }
    class ButtonsMessage implements IButtonsMessage {
      constructor(p?: proto.Message.IButtonsMessage);
      public contentText?: (string | null);
      public footerText?: (string | null);
      public contextInfo?: (proto.IContextInfo | null);
      public buttons: proto.Message.ButtonsMessage.IButton[];
      public headerType?: (proto.Message.ButtonsMessage.HeaderType | null);
      public text?: (string | null);
      public documentMessage?: (proto.Message.IDocumentMessage | null);
      public imageMessage?: (proto.Message.IImageMessage | null);
      public videoMessage?: (proto.Message.IVideoMessage | null);
      public locationMessage?: (proto.Message.ILocationMessage | null);
      public header?: ("text" | "documentMessage" | "imageMessage" | "videoMessage" | "locationMessage");
      public static create(properties?: proto.Message.IButtonsMessage): proto.Message.ButtonsMessage;
      public static encode(m: proto.Message.IButtonsMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ButtonsMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ButtonsMessage;
      public static toObject(m: proto.Message.ButtonsMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ButtonsMessage {
      interface IButton {
        buttonId?: (string | null);
        buttonText?: (proto.Message.ButtonsMessage.Button.IButtonText | null);
        type?: (proto.Message.ButtonsMessage.Button.Type | null);
        nativeFlowInfo?: (proto.Message.ButtonsMessage.Button.INativeFlowInfo | null);
      }
      class Button implements IButton {
        constructor(p?: proto.Message.ButtonsMessage.IButton);
        public buttonId?: (string | null);
        public buttonText?: (proto.Message.ButtonsMessage.Button.IButtonText | null);
        public type?: (proto.Message.ButtonsMessage.Button.Type | null);
        public nativeFlowInfo?: (proto.Message.ButtonsMessage.Button.INativeFlowInfo | null);
        public static create(properties?: proto.Message.ButtonsMessage.IButton): proto.Message.ButtonsMessage.Button;
        public static encode(m: proto.Message.ButtonsMessage.IButton, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ButtonsMessage.Button;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.ButtonsMessage.Button;
        public static toObject(m: proto.Message.ButtonsMessage.Button, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace Button {
        interface IButtonText {
          displayText?: (string | null);
        }
        class ButtonText implements IButtonText {
          constructor(p?: proto.Message.ButtonsMessage.Button.IButtonText);
          public displayText?: (string | null);
          public static create(properties?: proto.Message.ButtonsMessage.Button.IButtonText): proto.Message.ButtonsMessage.Button.ButtonText;
          public static encode(m: proto.Message.ButtonsMessage.Button.IButtonText, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ButtonsMessage.Button.ButtonText;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.ButtonsMessage.Button.ButtonText;
          public static toObject(m: proto.Message.ButtonsMessage.Button.ButtonText, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        interface INativeFlowInfo {
          name?: (string | null);
          paramsJson?: (string | null);
        }
        class NativeFlowInfo implements INativeFlowInfo {
          constructor(p?: proto.Message.ButtonsMessage.Button.INativeFlowInfo);
          public name?: (string | null);
          public paramsJson?: (string | null);
          public static create(properties?: proto.Message.ButtonsMessage.Button.INativeFlowInfo): proto.Message.ButtonsMessage.Button.NativeFlowInfo;
          public static encode(m: proto.Message.ButtonsMessage.Button.INativeFlowInfo, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ButtonsMessage.Button.NativeFlowInfo;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.ButtonsMessage.Button.NativeFlowInfo;
          public static toObject(m: proto.Message.ButtonsMessage.Button.NativeFlowInfo, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        enum Type {
          UNKNOWN = 0,
          RESPONSE = 1,
          NATIVE_FLOW = 2
        }
      }
      enum HeaderType {
        UNKNOWN = 0,
        EMPTY = 1,
        TEXT = 2,
        DOCUMENT = 3,
        IMAGE = 4,
        VIDEO = 5,
        LOCATION = 6
      }
    }
    interface IButtonsResponseMessage {
      selectedButtonId?: (string | null);
      contextInfo?: (proto.IContextInfo | null);
      type?: (proto.Message.ButtonsResponseMessage.Type | null);
      selectedDisplayText?: (string | null);
    }
    class ButtonsResponseMessage implements IButtonsResponseMessage {
      constructor(p?: proto.Message.IButtonsResponseMessage);
      public selectedButtonId?: (string | null);
      public contextInfo?: (proto.IContextInfo | null);
      public type?: (proto.Message.ButtonsResponseMessage.Type | null);
      public selectedDisplayText?: (string | null);
      public response?: "selectedDisplayText";
      public static create(properties?: proto.Message.IButtonsResponseMessage): proto.Message.ButtonsResponseMessage;
      public static encode(m: proto.Message.IButtonsResponseMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ButtonsResponseMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ButtonsResponseMessage;
      public static toObject(m: proto.Message.ButtonsResponseMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ButtonsResponseMessage {
      enum Type {
        UNKNOWN = 0,
        DISPLAY_TEXT = 1
      }
    }
    interface ICall {
      callKey?: (Uint8Array | null);
      conversionSource?: (string | null);
      conversionData?: (Uint8Array | null);
      conversionDelaySeconds?: (number | null);
      ctwaSignals?: (string | null);
      ctwaPayload?: (Uint8Array | null);
      contextInfo?: (proto.IContextInfo | null);
      nativeFlowCallButtonPayload?: (string | null);
      deeplinkPayload?: (string | null);
    }
    class Call implements ICall {
      constructor(p?: proto.Message.ICall);
      public callKey?: (Uint8Array | null);
      public conversionSource?: (string | null);
      public conversionData?: (Uint8Array | null);
      public conversionDelaySeconds?: (number | null);
      public ctwaSignals?: (string | null);
      public ctwaPayload?: (Uint8Array | null);
      public contextInfo?: (proto.IContextInfo | null);
      public nativeFlowCallButtonPayload?: (string | null);
      public deeplinkPayload?: (string | null);
      public static create(properties?: proto.Message.ICall): proto.Message.Call;
      public static encode(m: proto.Message.ICall, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.Call;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.Call;
      public static toObject(m: proto.Message.Call, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ICallLogMessage {
      isVideo?: (boolean | null);
      callOutcome?: (proto.Message.CallLogMessage.CallOutcome | null);
      durationSecs?: (number | Long$1 | null);
      callType?: (proto.Message.CallLogMessage.CallType | null);
      participants?: (proto.Message.CallLogMessage.ICallParticipant[] | null);
    }
    class CallLogMessage implements ICallLogMessage {
      constructor(p?: proto.Message.ICallLogMessage);
      public isVideo?: (boolean | null);
      public callOutcome?: (proto.Message.CallLogMessage.CallOutcome | null);
      public durationSecs?: (number | Long$1 | null);
      public callType?: (proto.Message.CallLogMessage.CallType | null);
      public participants: proto.Message.CallLogMessage.ICallParticipant[];
      public static create(properties?: proto.Message.ICallLogMessage): proto.Message.CallLogMessage;
      public static encode(m: proto.Message.ICallLogMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.CallLogMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.CallLogMessage;
      public static toObject(m: proto.Message.CallLogMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace CallLogMessage {
      enum CallOutcome {
        CONNECTED = 0,
        MISSED = 1,
        FAILED = 2,
        REJECTED = 3,
        ACCEPTED_ELSEWHERE = 4,
        ONGOING = 5,
        SILENCED_BY_DND = 6,
        SILENCED_UNKNOWN_CALLER = 7
      }
      interface ICallParticipant {
        jid?: (string | null);
        callOutcome?: (proto.Message.CallLogMessage.CallOutcome | null);
      }
      class CallParticipant implements ICallParticipant {
        constructor(p?: proto.Message.CallLogMessage.ICallParticipant);
        public jid?: (string | null);
        public callOutcome?: (proto.Message.CallLogMessage.CallOutcome | null);
        public static create(properties?: proto.Message.CallLogMessage.ICallParticipant): proto.Message.CallLogMessage.CallParticipant;
        public static encode(m: proto.Message.CallLogMessage.ICallParticipant, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.CallLogMessage.CallParticipant;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.CallLogMessage.CallParticipant;
        public static toObject(m: proto.Message.CallLogMessage.CallParticipant, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      enum CallType {
        REGULAR = 0,
        SCHEDULED_CALL = 1,
        VOICE_CHAT = 2
      }
    }
    interface ICancelPaymentRequestMessage {
      key?: (proto.IMessageKey | null);
    }
    class CancelPaymentRequestMessage implements ICancelPaymentRequestMessage {
      constructor(p?: proto.Message.ICancelPaymentRequestMessage);
      public key?: (proto.IMessageKey | null);
      public static create(properties?: proto.Message.ICancelPaymentRequestMessage): proto.Message.CancelPaymentRequestMessage;
      public static encode(m: proto.Message.ICancelPaymentRequestMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.CancelPaymentRequestMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.CancelPaymentRequestMessage;
      public static toObject(m: proto.Message.CancelPaymentRequestMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IChat {
      displayName?: (string | null);
      id?: (string | null);
    }
    class Chat implements IChat {
      constructor(p?: proto.Message.IChat);
      public displayName?: (string | null);
      public id?: (string | null);
      public static create(properties?: proto.Message.IChat): proto.Message.Chat;
      public static encode(m: proto.Message.IChat, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.Chat;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.Chat;
      public static toObject(m: proto.Message.Chat, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ICloudAPIThreadControlNotification {
      status?: (proto.Message.CloudAPIThreadControlNotification.CloudAPIThreadControl | null);
      senderNotificationTimestampMs?: (number | Long$1 | null);
      consumerLid?: (string | null);
      consumerPhoneNumber?: (string | null);
      notificationContent?: (proto.Message.CloudAPIThreadControlNotification.ICloudAPIThreadControlNotificationContent | null);
      shouldSuppressNotification?: (boolean | null);
    }
    class CloudAPIThreadControlNotification implements ICloudAPIThreadControlNotification {
      constructor(p?: proto.Message.ICloudAPIThreadControlNotification);
      public status?: (proto.Message.CloudAPIThreadControlNotification.CloudAPIThreadControl | null);
      public senderNotificationTimestampMs?: (number | Long$1 | null);
      public consumerLid?: (string | null);
      public consumerPhoneNumber?: (string | null);
      public notificationContent?: (proto.Message.CloudAPIThreadControlNotification.ICloudAPIThreadControlNotificationContent | null);
      public shouldSuppressNotification?: (boolean | null);
      public static create(properties?: proto.Message.ICloudAPIThreadControlNotification): proto.Message.CloudAPIThreadControlNotification;
      public static encode(m: proto.Message.ICloudAPIThreadControlNotification, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.CloudAPIThreadControlNotification;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.CloudAPIThreadControlNotification;
      public static toObject(m: proto.Message.CloudAPIThreadControlNotification, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace CloudAPIThreadControlNotification {
      enum CloudAPIThreadControl {
        UNKNOWN = 0,
        CONTROL_PASSED = 1,
        CONTROL_TAKEN = 2
      }
      interface ICloudAPIThreadControlNotificationContent {
        handoffNotificationText?: (string | null);
        extraJson?: (string | null);
      }
      class CloudAPIThreadControlNotificationContent implements ICloudAPIThreadControlNotificationContent {
        constructor(p?: proto.Message.CloudAPIThreadControlNotification.ICloudAPIThreadControlNotificationContent);
        public handoffNotificationText?: (string | null);
        public extraJson?: (string | null);
        public static create(properties?: proto.Message.CloudAPIThreadControlNotification.ICloudAPIThreadControlNotificationContent): proto.Message.CloudAPIThreadControlNotification.CloudAPIThreadControlNotificationContent;
        public static encode(m: proto.Message.CloudAPIThreadControlNotification.ICloudAPIThreadControlNotificationContent, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.CloudAPIThreadControlNotification.CloudAPIThreadControlNotificationContent;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.CloudAPIThreadControlNotification.CloudAPIThreadControlNotificationContent;
        public static toObject(m: proto.Message.CloudAPIThreadControlNotification.CloudAPIThreadControlNotificationContent, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface ICommentMessage {
      message?: (proto.IMessage | null);
      targetMessageKey?: (proto.IMessageKey | null);
    }
    class CommentMessage implements ICommentMessage {
      constructor(p?: proto.Message.ICommentMessage);
      public message?: (proto.IMessage | null);
      public targetMessageKey?: (proto.IMessageKey | null);
      public static create(properties?: proto.Message.ICommentMessage): proto.Message.CommentMessage;
      public static encode(m: proto.Message.ICommentMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.CommentMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.CommentMessage;
      public static toObject(m: proto.Message.CommentMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IContactMessage {
      displayName?: (string | null);
      vcard?: (string | null);
      contextInfo?: (proto.IContextInfo | null);
    }
    class ContactMessage implements IContactMessage {
      constructor(p?: proto.Message.IContactMessage);
      public displayName?: (string | null);
      public vcard?: (string | null);
      public contextInfo?: (proto.IContextInfo | null);
      public static create(properties?: proto.Message.IContactMessage): proto.Message.ContactMessage;
      public static encode(m: proto.Message.IContactMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ContactMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ContactMessage;
      public static toObject(m: proto.Message.ContactMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IContactsArrayMessage {
      displayName?: (string | null);
      contacts?: (proto.Message.IContactMessage[] | null);
      contextInfo?: (proto.IContextInfo | null);
    }
    class ContactsArrayMessage implements IContactsArrayMessage {
      constructor(p?: proto.Message.IContactsArrayMessage);
      public displayName?: (string | null);
      public contacts: proto.Message.IContactMessage[];
      public contextInfo?: (proto.IContextInfo | null);
      public static create(properties?: proto.Message.IContactsArrayMessage): proto.Message.ContactsArrayMessage;
      public static encode(m: proto.Message.IContactsArrayMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ContactsArrayMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ContactsArrayMessage;
      public static toObject(m: proto.Message.ContactsArrayMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IDeclinePaymentRequestMessage {
      key?: (proto.IMessageKey | null);
    }
    class DeclinePaymentRequestMessage implements IDeclinePaymentRequestMessage {
      constructor(p?: proto.Message.IDeclinePaymentRequestMessage);
      public key?: (proto.IMessageKey | null);
      public static create(properties?: proto.Message.IDeclinePaymentRequestMessage): proto.Message.DeclinePaymentRequestMessage;
      public static encode(m: proto.Message.IDeclinePaymentRequestMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.DeclinePaymentRequestMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.DeclinePaymentRequestMessage;
      public static toObject(m: proto.Message.DeclinePaymentRequestMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IDeviceSentMessage {
      destinationJid?: (string | null);
      message?: (proto.IMessage | null);
      phash?: (string | null);
    }
    class DeviceSentMessage implements IDeviceSentMessage {
      constructor(p?: proto.Message.IDeviceSentMessage);
      public destinationJid?: (string | null);
      public message?: (proto.IMessage | null);
      public phash?: (string | null);
      public static create(properties?: proto.Message.IDeviceSentMessage): proto.Message.DeviceSentMessage;
      public static encode(m: proto.Message.IDeviceSentMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.DeviceSentMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.DeviceSentMessage;
      public static toObject(m: proto.Message.DeviceSentMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IDocumentMessage {
      url?: (string | null);
      mimetype?: (string | null);
      title?: (string | null);
      fileSha256?: (Uint8Array | null);
      fileLength?: (number | Long$1 | null);
      pageCount?: (number | null);
      mediaKey?: (Uint8Array | null);
      fileName?: (string | null);
      fileEncSha256?: (Uint8Array | null);
      directPath?: (string | null);
      mediaKeyTimestamp?: (number | Long$1 | null);
      contactVcard?: (boolean | null);
      thumbnailDirectPath?: (string | null);
      thumbnailSha256?: (Uint8Array | null);
      thumbnailEncSha256?: (Uint8Array | null);
      jpegThumbnail?: (Uint8Array | null);
      contextInfo?: (proto.IContextInfo | null);
      thumbnailHeight?: (number | null);
      thumbnailWidth?: (number | null);
      caption?: (string | null);
      accessibilityLabel?: (string | null);
      mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
    }
    class DocumentMessage implements IDocumentMessage {
      constructor(p?: proto.Message.IDocumentMessage);
      public url?: (string | null);
      public mimetype?: (string | null);
      public title?: (string | null);
      public fileSha256?: (Uint8Array | null);
      public fileLength?: (number | Long$1 | null);
      public pageCount?: (number | null);
      public mediaKey?: (Uint8Array | null);
      public fileName?: (string | null);
      public fileEncSha256?: (Uint8Array | null);
      public directPath?: (string | null);
      public mediaKeyTimestamp?: (number | Long$1 | null);
      public contactVcard?: (boolean | null);
      public thumbnailDirectPath?: (string | null);
      public thumbnailSha256?: (Uint8Array | null);
      public thumbnailEncSha256?: (Uint8Array | null);
      public jpegThumbnail?: (Uint8Array | null);
      public contextInfo?: (proto.IContextInfo | null);
      public thumbnailHeight?: (number | null);
      public thumbnailWidth?: (number | null);
      public caption?: (string | null);
      public accessibilityLabel?: (string | null);
      public mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
      public static create(properties?: proto.Message.IDocumentMessage): proto.Message.DocumentMessage;
      public static encode(m: proto.Message.IDocumentMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.DocumentMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.DocumentMessage;
      public static toObject(m: proto.Message.DocumentMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IEncCommentMessage {
      targetMessageKey?: (proto.IMessageKey | null);
      encPayload?: (Uint8Array | null);
      encIv?: (Uint8Array | null);
    }
    class EncCommentMessage implements IEncCommentMessage {
      constructor(p?: proto.Message.IEncCommentMessage);
      public targetMessageKey?: (proto.IMessageKey | null);
      public encPayload?: (Uint8Array | null);
      public encIv?: (Uint8Array | null);
      public static create(properties?: proto.Message.IEncCommentMessage): proto.Message.EncCommentMessage;
      public static encode(m: proto.Message.IEncCommentMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.EncCommentMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.EncCommentMessage;
      public static toObject(m: proto.Message.EncCommentMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IEncEventResponseMessage {
      eventCreationMessageKey?: (proto.IMessageKey | null);
      encPayload?: (Uint8Array | null);
      encIv?: (Uint8Array | null);
    }
    class EncEventResponseMessage implements IEncEventResponseMessage {
      constructor(p?: proto.Message.IEncEventResponseMessage);
      public eventCreationMessageKey?: (proto.IMessageKey | null);
      public encPayload?: (Uint8Array | null);
      public encIv?: (Uint8Array | null);
      public static create(properties?: proto.Message.IEncEventResponseMessage): proto.Message.EncEventResponseMessage;
      public static encode(m: proto.Message.IEncEventResponseMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.EncEventResponseMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.EncEventResponseMessage;
      public static toObject(m: proto.Message.EncEventResponseMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IEncReactionMessage {
      targetMessageKey?: (proto.IMessageKey | null);
      encPayload?: (Uint8Array | null);
      encIv?: (Uint8Array | null);
    }
    class EncReactionMessage implements IEncReactionMessage {
      constructor(p?: proto.Message.IEncReactionMessage);
      public targetMessageKey?: (proto.IMessageKey | null);
      public encPayload?: (Uint8Array | null);
      public encIv?: (Uint8Array | null);
      public static create(properties?: proto.Message.IEncReactionMessage): proto.Message.EncReactionMessage;
      public static encode(m: proto.Message.IEncReactionMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.EncReactionMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.EncReactionMessage;
      public static toObject(m: proto.Message.EncReactionMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IEventMessage {
      contextInfo?: (proto.IContextInfo | null);
      isCanceled?: (boolean | null);
      name?: (string | null);
      description?: (string | null);
      location?: (proto.Message.ILocationMessage | null);
      joinLink?: (string | null);
      startTime?: (number | Long$1 | null);
      endTime?: (number | Long$1 | null);
      extraGuestsAllowed?: (boolean | null);
      isScheduleCall?: (boolean | null);
      hasReminder?: (boolean | null);
      reminderOffsetSec?: (number | Long$1 | null);
    }
    class EventMessage implements IEventMessage {
      constructor(p?: proto.Message.IEventMessage);
      public contextInfo?: (proto.IContextInfo | null);
      public isCanceled?: (boolean | null);
      public name?: (string | null);
      public description?: (string | null);
      public location?: (proto.Message.ILocationMessage | null);
      public joinLink?: (string | null);
      public startTime?: (number | Long$1 | null);
      public endTime?: (number | Long$1 | null);
      public extraGuestsAllowed?: (boolean | null);
      public isScheduleCall?: (boolean | null);
      public hasReminder?: (boolean | null);
      public reminderOffsetSec?: (number | Long$1 | null);
      public static create(properties?: proto.Message.IEventMessage): proto.Message.EventMessage;
      public static encode(m: proto.Message.IEventMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.EventMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.EventMessage;
      public static toObject(m: proto.Message.EventMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IEventResponseMessage {
      response?: (proto.Message.EventResponseMessage.EventResponseType | null);
      timestampMs?: (number | Long$1 | null);
      extraGuestCount?: (number | null);
    }
    class EventResponseMessage implements IEventResponseMessage {
      constructor(p?: proto.Message.IEventResponseMessage);
      public response?: (proto.Message.EventResponseMessage.EventResponseType | null);
      public timestampMs?: (number | Long$1 | null);
      public extraGuestCount?: (number | null);
      public static create(properties?: proto.Message.IEventResponseMessage): proto.Message.EventResponseMessage;
      public static encode(m: proto.Message.IEventResponseMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.EventResponseMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.EventResponseMessage;
      public static toObject(m: proto.Message.EventResponseMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace EventResponseMessage {
      enum EventResponseType {
        UNKNOWN = 0,
        GOING = 1,
        NOT_GOING = 2,
        MAYBE = 3
      }
    }
    interface IExtendedTextMessage {
      text?: (string | null);
      matchedText?: (string | null);
      description?: (string | null);
      title?: (string | null);
      textArgb?: (number | null);
      backgroundArgb?: (number | null);
      font?: (proto.Message.ExtendedTextMessage.FontType | null);
      previewType?: (proto.Message.ExtendedTextMessage.PreviewType | null);
      jpegThumbnail?: (Uint8Array | null);
      contextInfo?: (proto.IContextInfo | null);
      doNotPlayInline?: (boolean | null);
      thumbnailDirectPath?: (string | null);
      thumbnailSha256?: (Uint8Array | null);
      thumbnailEncSha256?: (Uint8Array | null);
      mediaKey?: (Uint8Array | null);
      mediaKeyTimestamp?: (number | Long$1 | null);
      thumbnailHeight?: (number | null);
      thumbnailWidth?: (number | null);
      inviteLinkGroupType?: (proto.Message.ExtendedTextMessage.InviteLinkGroupType | null);
      inviteLinkParentGroupSubjectV2?: (string | null);
      inviteLinkParentGroupThumbnailV2?: (Uint8Array | null);
      inviteLinkGroupTypeV2?: (proto.Message.ExtendedTextMessage.InviteLinkGroupType | null);
      viewOnce?: (boolean | null);
      videoHeight?: (number | null);
      videoWidth?: (number | null);
      faviconMMSMetadata?: (proto.Message.IMMSThumbnailMetadata | null);
      linkPreviewMetadata?: (proto.Message.ILinkPreviewMetadata | null);
      paymentLinkMetadata?: (proto.Message.IPaymentLinkMetadata | null);
      endCardTiles?: (proto.Message.IVideoEndCard[] | null);
      videoContentUrl?: (string | null);
      musicMetadata?: (proto.IEmbeddedMusic | null);
      paymentExtendedMetadata?: (proto.Message.IPaymentExtendedMetadata | null);
    }
    class ExtendedTextMessage implements IExtendedTextMessage {
      constructor(p?: proto.Message.IExtendedTextMessage);
      public text?: (string | null);
      public matchedText?: (string | null);
      public description?: (string | null);
      public title?: (string | null);
      public textArgb?: (number | null);
      public backgroundArgb?: (number | null);
      public font?: (proto.Message.ExtendedTextMessage.FontType | null);
      public previewType?: (proto.Message.ExtendedTextMessage.PreviewType | null);
      public jpegThumbnail?: (Uint8Array | null);
      public contextInfo?: (proto.IContextInfo | null);
      public doNotPlayInline?: (boolean | null);
      public thumbnailDirectPath?: (string | null);
      public thumbnailSha256?: (Uint8Array | null);
      public thumbnailEncSha256?: (Uint8Array | null);
      public mediaKey?: (Uint8Array | null);
      public mediaKeyTimestamp?: (number | Long$1 | null);
      public thumbnailHeight?: (number | null);
      public thumbnailWidth?: (number | null);
      public inviteLinkGroupType?: (proto.Message.ExtendedTextMessage.InviteLinkGroupType | null);
      public inviteLinkParentGroupSubjectV2?: (string | null);
      public inviteLinkParentGroupThumbnailV2?: (Uint8Array | null);
      public inviteLinkGroupTypeV2?: (proto.Message.ExtendedTextMessage.InviteLinkGroupType | null);
      public viewOnce?: (boolean | null);
      public videoHeight?: (number | null);
      public videoWidth?: (number | null);
      public faviconMMSMetadata?: (proto.Message.IMMSThumbnailMetadata | null);
      public linkPreviewMetadata?: (proto.Message.ILinkPreviewMetadata | null);
      public paymentLinkMetadata?: (proto.Message.IPaymentLinkMetadata | null);
      public endCardTiles: proto.Message.IVideoEndCard[];
      public videoContentUrl?: (string | null);
      public musicMetadata?: (proto.IEmbeddedMusic | null);
      public paymentExtendedMetadata?: (proto.Message.IPaymentExtendedMetadata | null);
      public static create(properties?: proto.Message.IExtendedTextMessage): proto.Message.ExtendedTextMessage;
      public static encode(m: proto.Message.IExtendedTextMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ExtendedTextMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ExtendedTextMessage;
      public static toObject(m: proto.Message.ExtendedTextMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ExtendedTextMessage {
      enum FontType {
        SYSTEM = 0,
        SYSTEM_TEXT = 1,
        FB_SCRIPT = 2,
        SYSTEM_BOLD = 6,
        MORNINGBREEZE_REGULAR = 7,
        CALISTOGA_REGULAR = 8,
        EXO2_EXTRABOLD = 9,
        COURIERPRIME_BOLD = 10
      }
      enum InviteLinkGroupType {
        DEFAULT = 0,
        PARENT = 1,
        SUB = 2,
        DEFAULT_SUB = 3
      }
      enum PreviewType {
        NONE = 0,
        VIDEO = 1,
        PLACEHOLDER = 4,
        IMAGE = 5,
        PAYMENT_LINKS = 6,
        PROFILE = 7
      }
    }
    interface IFullHistorySyncOnDemandRequestMetadata {
      requestId?: (string | null);
    }
    class FullHistorySyncOnDemandRequestMetadata implements IFullHistorySyncOnDemandRequestMetadata {
      constructor(p?: proto.Message.IFullHistorySyncOnDemandRequestMetadata);
      public requestId?: (string | null);
      public static create(properties?: proto.Message.IFullHistorySyncOnDemandRequestMetadata): proto.Message.FullHistorySyncOnDemandRequestMetadata;
      public static encode(m: proto.Message.IFullHistorySyncOnDemandRequestMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.FullHistorySyncOnDemandRequestMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.FullHistorySyncOnDemandRequestMetadata;
      public static toObject(m: proto.Message.FullHistorySyncOnDemandRequestMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IFutureProofMessage {
      message?: (proto.IMessage | null);
    }
    class FutureProofMessage implements IFutureProofMessage {
      constructor(p?: proto.Message.IFutureProofMessage);
      public message?: (proto.IMessage | null);
      public static create(properties?: proto.Message.IFutureProofMessage): proto.Message.FutureProofMessage;
      public static encode(m: proto.Message.IFutureProofMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.FutureProofMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.FutureProofMessage;
      public static toObject(m: proto.Message.FutureProofMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IGroupInviteMessage {
      groupJid?: (string | null);
      inviteCode?: (string | null);
      inviteExpiration?: (number | Long$1 | null);
      groupName?: (string | null);
      jpegThumbnail?: (Uint8Array | null);
      caption?: (string | null);
      contextInfo?: (proto.IContextInfo | null);
      groupType?: (proto.Message.GroupInviteMessage.GroupType | null);
    }
    class GroupInviteMessage implements IGroupInviteMessage {
      constructor(p?: proto.Message.IGroupInviteMessage);
      public groupJid?: (string | null);
      public inviteCode?: (string | null);
      public inviteExpiration?: (number | Long$1 | null);
      public groupName?: (string | null);
      public jpegThumbnail?: (Uint8Array | null);
      public caption?: (string | null);
      public contextInfo?: (proto.IContextInfo | null);
      public groupType?: (proto.Message.GroupInviteMessage.GroupType | null);
      public static create(properties?: proto.Message.IGroupInviteMessage): proto.Message.GroupInviteMessage;
      public static encode(m: proto.Message.IGroupInviteMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.GroupInviteMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.GroupInviteMessage;
      public static toObject(m: proto.Message.GroupInviteMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace GroupInviteMessage {
      enum GroupType {
        DEFAULT = 0,
        PARENT = 1
      }
    }
    interface IHighlyStructuredMessage {
      namespace?: (string | null);
      elementName?: (string | null);
      params?: (string[] | null);
      fallbackLg?: (string | null);
      fallbackLc?: (string | null);
      localizableParams?: (proto.Message.HighlyStructuredMessage.IHSMLocalizableParameter[] | null);
      deterministicLg?: (string | null);
      deterministicLc?: (string | null);
      hydratedHsm?: (proto.Message.ITemplateMessage | null);
    }
    class HighlyStructuredMessage implements IHighlyStructuredMessage {
      constructor(p?: proto.Message.IHighlyStructuredMessage);
      public namespace?: (string | null);
      public elementName?: (string | null);
      public params: string[];
      public fallbackLg?: (string | null);
      public fallbackLc?: (string | null);
      public localizableParams: proto.Message.HighlyStructuredMessage.IHSMLocalizableParameter[];
      public deterministicLg?: (string | null);
      public deterministicLc?: (string | null);
      public hydratedHsm?: (proto.Message.ITemplateMessage | null);
      public static create(properties?: proto.Message.IHighlyStructuredMessage): proto.Message.HighlyStructuredMessage;
      public static encode(m: proto.Message.IHighlyStructuredMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.HighlyStructuredMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.HighlyStructuredMessage;
      public static toObject(m: proto.Message.HighlyStructuredMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace HighlyStructuredMessage {
      interface IHSMLocalizableParameter {
        "default"?: (string | null);
        currency?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.IHSMCurrency | null);
        dateTime?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.IHSMDateTime | null);
      }
      class HSMLocalizableParameter implements IHSMLocalizableParameter {
        constructor(p?: proto.Message.HighlyStructuredMessage.IHSMLocalizableParameter);
        public default?: (string | null);
        public currency?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.IHSMCurrency | null);
        public dateTime?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.IHSMDateTime | null);
        public paramOneof?: ("currency" | "dateTime");
        public static create(properties?: proto.Message.HighlyStructuredMessage.IHSMLocalizableParameter): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter;
        public static encode(m: proto.Message.HighlyStructuredMessage.IHSMLocalizableParameter, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter;
        public static toObject(m: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace HSMLocalizableParameter {
        interface IHSMCurrency {
          currencyCode?: (string | null);
          amount1000?: (number | Long$1 | null);
        }
        class HSMCurrency implements IHSMCurrency {
          constructor(p?: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.IHSMCurrency);
          public currencyCode?: (string | null);
          public amount1000?: (number | Long$1 | null);
          public static create(properties?: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.IHSMCurrency): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMCurrency;
          public static encode(m: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.IHSMCurrency, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMCurrency;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMCurrency;
          public static toObject(m: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMCurrency, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        interface IHSMDateTime {
          component?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.IHSMDateTimeComponent | null);
          unixEpoch?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.IHSMDateTimeUnixEpoch | null);
        }
        class HSMDateTime implements IHSMDateTime {
          constructor(p?: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.IHSMDateTime);
          public component?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.IHSMDateTimeComponent | null);
          public unixEpoch?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.IHSMDateTimeUnixEpoch | null);
          public datetimeOneof?: ("component" | "unixEpoch");
          public static create(properties?: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.IHSMDateTime): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime;
          public static encode(m: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.IHSMDateTime, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime;
          public static toObject(m: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        namespace HSMDateTime {
          interface IHSMDateTimeComponent {
            dayOfWeek?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeComponent.DayOfWeekType | null);
            year?: (number | null);
            month?: (number | null);
            dayOfMonth?: (number | null);
            hour?: (number | null);
            minute?: (number | null);
            calendar?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeComponent.CalendarType | null);
          }
          class HSMDateTimeComponent implements IHSMDateTimeComponent {
            constructor(p?: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.IHSMDateTimeComponent);
            public dayOfWeek?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeComponent.DayOfWeekType | null);
            public year?: (number | null);
            public month?: (number | null);
            public dayOfMonth?: (number | null);
            public hour?: (number | null);
            public minute?: (number | null);
            public calendar?: (proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeComponent.CalendarType | null);
            public static create(properties?: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.IHSMDateTimeComponent): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeComponent;
            public static encode(m: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.IHSMDateTimeComponent, w?: Writer): Writer;
            public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeComponent;
            public static fromObject(d: {
              [k: string]: any;
            }): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeComponent;
            public static toObject(m: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeComponent, o?: IConversionOptions): {
              [k: string]: any;
            };
            public toJSON(): {
              [k: string]: any;
            };
            public static getTypeUrl(typeUrlPrefix?: string): string;
          }
          namespace HSMDateTimeComponent {
            enum CalendarType {
              GREGORIAN = 1,
              SOLAR_HIJRI = 2
            }
            enum DayOfWeekType {
              MONDAY = 1,
              TUESDAY = 2,
              WEDNESDAY = 3,
              THURSDAY = 4,
              FRIDAY = 5,
              SATURDAY = 6,
              SUNDAY = 7
            }
          }
          interface IHSMDateTimeUnixEpoch {
            timestamp?: (number | Long$1 | null);
          }
          class HSMDateTimeUnixEpoch implements IHSMDateTimeUnixEpoch {
            constructor(p?: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.IHSMDateTimeUnixEpoch);
            public timestamp?: (number | Long$1 | null);
            public static create(properties?: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.IHSMDateTimeUnixEpoch): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeUnixEpoch;
            public static encode(m: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.IHSMDateTimeUnixEpoch, w?: Writer): Writer;
            public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeUnixEpoch;
            public static fromObject(d: {
              [k: string]: any;
            }): proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeUnixEpoch;
            public static toObject(m: proto.Message.HighlyStructuredMessage.HSMLocalizableParameter.HSMDateTime.HSMDateTimeUnixEpoch, o?: IConversionOptions): {
              [k: string]: any;
            };
            public toJSON(): {
              [k: string]: any;
            };
            public static getTypeUrl(typeUrlPrefix?: string): string;
          }
        }
      }
    }
    interface IHistorySyncMessageAccessStatus {
      completeAccessGranted?: (boolean | null);
    }
    class HistorySyncMessageAccessStatus implements IHistorySyncMessageAccessStatus {
      constructor(p?: proto.Message.IHistorySyncMessageAccessStatus);
      public completeAccessGranted?: (boolean | null);
      public static create(properties?: proto.Message.IHistorySyncMessageAccessStatus): proto.Message.HistorySyncMessageAccessStatus;
      public static encode(m: proto.Message.IHistorySyncMessageAccessStatus, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.HistorySyncMessageAccessStatus;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.HistorySyncMessageAccessStatus;
      public static toObject(m: proto.Message.HistorySyncMessageAccessStatus, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IHistorySyncNotification {
      fileSha256?: (Uint8Array | null);
      fileLength?: (number | Long$1 | null);
      mediaKey?: (Uint8Array | null);
      fileEncSha256?: (Uint8Array | null);
      directPath?: (string | null);
      syncType?: (proto.Message.HistorySyncType | null);
      chunkOrder?: (number | null);
      originalMessageId?: (string | null);
      progress?: (number | null);
      oldestMsgInChunkTimestampSec?: (number | Long$1 | null);
      initialHistBootstrapInlinePayload?: (Uint8Array | null);
      peerDataRequestSessionId?: (string | null);
      fullHistorySyncOnDemandRequestMetadata?: (proto.Message.IFullHistorySyncOnDemandRequestMetadata | null);
      encHandle?: (string | null);
      messageAccessStatus?: (proto.Message.IHistorySyncMessageAccessStatus | null);
    }
    class HistorySyncNotification implements IHistorySyncNotification {
      constructor(p?: proto.Message.IHistorySyncNotification);
      public fileSha256?: (Uint8Array | null);
      public fileLength?: (number | Long$1 | null);
      public mediaKey?: (Uint8Array | null);
      public fileEncSha256?: (Uint8Array | null);
      public directPath?: (string | null);
      public syncType?: (proto.Message.HistorySyncType | null);
      public chunkOrder?: (number | null);
      public originalMessageId?: (string | null);
      public progress?: (number | null);
      public oldestMsgInChunkTimestampSec?: (number | Long$1 | null);
      public initialHistBootstrapInlinePayload?: (Uint8Array | null);
      public peerDataRequestSessionId?: (string | null);
      public fullHistorySyncOnDemandRequestMetadata?: (proto.Message.IFullHistorySyncOnDemandRequestMetadata | null);
      public encHandle?: (string | null);
      public messageAccessStatus?: (proto.Message.IHistorySyncMessageAccessStatus | null);
      public static create(properties?: proto.Message.IHistorySyncNotification): proto.Message.HistorySyncNotification;
      public static encode(m: proto.Message.IHistorySyncNotification, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.HistorySyncNotification;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.HistorySyncNotification;
      public static toObject(m: proto.Message.HistorySyncNotification, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum HistorySyncType {
      INITIAL_BOOTSTRAP = 0,
      INITIAL_STATUS_V3 = 1,
      FULL = 2,
      RECENT = 3,
      PUSH_NAME = 4,
      NON_BLOCKING_DATA = 5,
      ON_DEMAND = 6,
      NO_HISTORY = 7,
      MESSAGE_ACCESS_STATUS = 8
    }
    interface IImageMessage {
      url?: (string | null);
      mimetype?: (string | null);
      caption?: (string | null);
      fileSha256?: (Uint8Array | null);
      fileLength?: (number | Long$1 | null);
      height?: (number | null);
      width?: (number | null);
      mediaKey?: (Uint8Array | null);
      fileEncSha256?: (Uint8Array | null);
      interactiveAnnotations?: (proto.IInteractiveAnnotation[] | null);
      directPath?: (string | null);
      mediaKeyTimestamp?: (number | Long$1 | null);
      jpegThumbnail?: (Uint8Array | null);
      contextInfo?: (proto.IContextInfo | null);
      firstScanSidecar?: (Uint8Array | null);
      firstScanLength?: (number | null);
      experimentGroupId?: (number | null);
      scansSidecar?: (Uint8Array | null);
      scanLengths?: (number[] | null);
      midQualityFileSha256?: (Uint8Array | null);
      midQualityFileEncSha256?: (Uint8Array | null);
      viewOnce?: (boolean | null);
      thumbnailDirectPath?: (string | null);
      thumbnailSha256?: (Uint8Array | null);
      thumbnailEncSha256?: (Uint8Array | null);
      staticUrl?: (string | null);
      annotations?: (proto.IInteractiveAnnotation[] | null);
      imageSourceType?: (proto.Message.ImageMessage.ImageSourceType | null);
      accessibilityLabel?: (string | null);
      mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
      qrUrl?: (string | null);
    }
    class ImageMessage implements IImageMessage {
      constructor(p?: proto.Message.IImageMessage);
      public url?: (string | null);
      public mimetype?: (string | null);
      public caption?: (string | null);
      public fileSha256?: (Uint8Array | null);
      public fileLength?: (number | Long$1 | null);
      public height?: (number | null);
      public width?: (number | null);
      public mediaKey?: (Uint8Array | null);
      public fileEncSha256?: (Uint8Array | null);
      public interactiveAnnotations: proto.IInteractiveAnnotation[];
      public directPath?: (string | null);
      public mediaKeyTimestamp?: (number | Long$1 | null);
      public jpegThumbnail?: (Uint8Array | null);
      public contextInfo?: (proto.IContextInfo | null);
      public firstScanSidecar?: (Uint8Array | null);
      public firstScanLength?: (number | null);
      public experimentGroupId?: (number | null);
      public scansSidecar?: (Uint8Array | null);
      public scanLengths: number[];
      public midQualityFileSha256?: (Uint8Array | null);
      public midQualityFileEncSha256?: (Uint8Array | null);
      public viewOnce?: (boolean | null);
      public thumbnailDirectPath?: (string | null);
      public thumbnailSha256?: (Uint8Array | null);
      public thumbnailEncSha256?: (Uint8Array | null);
      public staticUrl?: (string | null);
      public annotations: proto.IInteractiveAnnotation[];
      public imageSourceType?: (proto.Message.ImageMessage.ImageSourceType | null);
      public accessibilityLabel?: (string | null);
      public mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
      public qrUrl?: (string | null);
      public static create(properties?: proto.Message.IImageMessage): proto.Message.ImageMessage;
      public static encode(m: proto.Message.IImageMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ImageMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ImageMessage;
      public static toObject(m: proto.Message.ImageMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ImageMessage {
      enum ImageSourceType {
        USER_IMAGE = 0,
        AI_GENERATED = 1,
        AI_MODIFIED = 2,
        RASTERIZED_TEXT_STATUS = 3
      }
    }
    interface IInitialSecurityNotificationSettingSync {
      securityNotificationEnabled?: (boolean | null);
    }
    class InitialSecurityNotificationSettingSync implements IInitialSecurityNotificationSettingSync {
      constructor(p?: proto.Message.IInitialSecurityNotificationSettingSync);
      public securityNotificationEnabled?: (boolean | null);
      public static create(properties?: proto.Message.IInitialSecurityNotificationSettingSync): proto.Message.InitialSecurityNotificationSettingSync;
      public static encode(m: proto.Message.IInitialSecurityNotificationSettingSync, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InitialSecurityNotificationSettingSync;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.InitialSecurityNotificationSettingSync;
      public static toObject(m: proto.Message.InitialSecurityNotificationSettingSync, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IInteractiveMessage {
      header?: (proto.Message.InteractiveMessage.IHeader | null);
      body?: (proto.Message.InteractiveMessage.IBody | null);
      footer?: (proto.Message.InteractiveMessage.IFooter | null);
      contextInfo?: (proto.IContextInfo | null);
      urlTrackingMap?: (proto.IUrlTrackingMap | null);
      shopStorefrontMessage?: (proto.Message.InteractiveMessage.IShopMessage | null);
      collectionMessage?: (proto.Message.InteractiveMessage.ICollectionMessage | null);
      nativeFlowMessage?: (proto.Message.InteractiveMessage.INativeFlowMessage | null);
      carouselMessage?: (proto.Message.InteractiveMessage.ICarouselMessage | null);
    }
    class InteractiveMessage implements IInteractiveMessage {
      constructor(p?: proto.Message.IInteractiveMessage);
      public header?: (proto.Message.InteractiveMessage.IHeader | null);
      public body?: (proto.Message.InteractiveMessage.IBody | null);
      public footer?: (proto.Message.InteractiveMessage.IFooter | null);
      public contextInfo?: (proto.IContextInfo | null);
      public urlTrackingMap?: (proto.IUrlTrackingMap | null);
      public shopStorefrontMessage?: (proto.Message.InteractiveMessage.IShopMessage | null);
      public collectionMessage?: (proto.Message.InteractiveMessage.ICollectionMessage | null);
      public nativeFlowMessage?: (proto.Message.InteractiveMessage.INativeFlowMessage | null);
      public carouselMessage?: (proto.Message.InteractiveMessage.ICarouselMessage | null);
      public interactiveMessage?: ("shopStorefrontMessage" | "collectionMessage" | "nativeFlowMessage" | "carouselMessage");
      public static create(properties?: proto.Message.IInteractiveMessage): proto.Message.InteractiveMessage;
      public static encode(m: proto.Message.IInteractiveMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.InteractiveMessage;
      public static toObject(m: proto.Message.InteractiveMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace InteractiveMessage {
      interface IBody {
        text?: (string | null);
      }
      class Body implements IBody {
        constructor(p?: proto.Message.InteractiveMessage.IBody);
        public text?: (string | null);
        public static create(properties?: proto.Message.InteractiveMessage.IBody): proto.Message.InteractiveMessage.Body;
        public static encode(m: proto.Message.InteractiveMessage.IBody, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveMessage.Body;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.InteractiveMessage.Body;
        public static toObject(m: proto.Message.InteractiveMessage.Body, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface ICarouselMessage {
        cards?: (proto.Message.IInteractiveMessage[] | null);
        messageVersion?: (number | null);
        carouselCardType?: (proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType | null);
      }
      class CarouselMessage implements ICarouselMessage {
        constructor(p?: proto.Message.InteractiveMessage.ICarouselMessage);
        public cards: proto.Message.IInteractiveMessage[];
        public messageVersion?: (number | null);
        public carouselCardType?: (proto.Message.InteractiveMessage.CarouselMessage.CarouselCardType | null);
        public static create(properties?: proto.Message.InteractiveMessage.ICarouselMessage): proto.Message.InteractiveMessage.CarouselMessage;
        public static encode(m: proto.Message.InteractiveMessage.ICarouselMessage, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveMessage.CarouselMessage;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.InteractiveMessage.CarouselMessage;
        public static toObject(m: proto.Message.InteractiveMessage.CarouselMessage, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace CarouselMessage {
        enum CarouselCardType {
          UNKNOWN = 0,
          HSCROLL_CARDS = 1,
          ALBUM_IMAGE = 2
        }
      }
      interface ICollectionMessage {
        bizJid?: (string | null);
        id?: (string | null);
        messageVersion?: (number | null);
      }
      class CollectionMessage implements ICollectionMessage {
        constructor(p?: proto.Message.InteractiveMessage.ICollectionMessage);
        public bizJid?: (string | null);
        public id?: (string | null);
        public messageVersion?: (number | null);
        public static create(properties?: proto.Message.InteractiveMessage.ICollectionMessage): proto.Message.InteractiveMessage.CollectionMessage;
        public static encode(m: proto.Message.InteractiveMessage.ICollectionMessage, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveMessage.CollectionMessage;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.InteractiveMessage.CollectionMessage;
        public static toObject(m: proto.Message.InteractiveMessage.CollectionMessage, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IFooter {
        text?: (string | null);
        hasMediaAttachment?: (boolean | null);
        audioMessage?: (proto.Message.IAudioMessage | null);
      }
      class Footer implements IFooter {
        constructor(p?: proto.Message.InteractiveMessage.IFooter);
        public text?: (string | null);
        public hasMediaAttachment?: (boolean | null);
        public audioMessage?: (proto.Message.IAudioMessage | null);
        public media?: "audioMessage";
        public static create(properties?: proto.Message.InteractiveMessage.IFooter): proto.Message.InteractiveMessage.Footer;
        public static encode(m: proto.Message.InteractiveMessage.IFooter, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveMessage.Footer;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.InteractiveMessage.Footer;
        public static toObject(m: proto.Message.InteractiveMessage.Footer, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IHeader {
        title?: (string | null);
        subtitle?: (string | null);
        hasMediaAttachment?: (boolean | null);
        documentMessage?: (proto.Message.IDocumentMessage | null);
        imageMessage?: (proto.Message.IImageMessage | null);
        jpegThumbnail?: (Uint8Array | null);
        videoMessage?: (proto.Message.IVideoMessage | null);
        locationMessage?: (proto.Message.ILocationMessage | null);
        productMessage?: (proto.Message.IProductMessage | null);
      }
      class Header implements IHeader {
        constructor(p?: proto.Message.InteractiveMessage.IHeader);
        public title?: (string | null);
        public subtitle?: (string | null);
        public hasMediaAttachment?: (boolean | null);
        public documentMessage?: (proto.Message.IDocumentMessage | null);
        public imageMessage?: (proto.Message.IImageMessage | null);
        public jpegThumbnail?: (Uint8Array | null);
        public videoMessage?: (proto.Message.IVideoMessage | null);
        public locationMessage?: (proto.Message.ILocationMessage | null);
        public productMessage?: (proto.Message.IProductMessage | null);
        public media?: ("documentMessage" | "imageMessage" | "jpegThumbnail" | "videoMessage" | "locationMessage" | "productMessage");
        public static create(properties?: proto.Message.InteractiveMessage.IHeader): proto.Message.InteractiveMessage.Header;
        public static encode(m: proto.Message.InteractiveMessage.IHeader, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveMessage.Header;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.InteractiveMessage.Header;
        public static toObject(m: proto.Message.InteractiveMessage.Header, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface INativeFlowMessage {
        buttons?: (proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton[] | null);
        messageParamsJson?: (string | null);
        messageVersion?: (number | null);
      }
      class NativeFlowMessage implements INativeFlowMessage {
        constructor(p?: proto.Message.InteractiveMessage.INativeFlowMessage);
        public buttons: proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton[];
        public messageParamsJson?: (string | null);
        public messageVersion?: (number | null);
        public static create(properties?: proto.Message.InteractiveMessage.INativeFlowMessage): proto.Message.InteractiveMessage.NativeFlowMessage;
        public static encode(m: proto.Message.InteractiveMessage.INativeFlowMessage, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveMessage.NativeFlowMessage;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.InteractiveMessage.NativeFlowMessage;
        public static toObject(m: proto.Message.InteractiveMessage.NativeFlowMessage, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace NativeFlowMessage {
        interface INativeFlowButton {
          name?: (string | null);
          buttonParamsJson?: (string | null);
        }
        class NativeFlowButton implements INativeFlowButton {
          constructor(p?: proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton);
          public name?: (string | null);
          public buttonParamsJson?: (string | null);
          public static create(properties?: proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton): proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton;
          public static encode(m: proto.Message.InteractiveMessage.NativeFlowMessage.INativeFlowButton, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton;
          public static toObject(m: proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
      }
      interface IShopMessage {
        id?: (string | null);
        surface?: (proto.Message.InteractiveMessage.ShopMessage.Surface | null);
        messageVersion?: (number | null);
      }
      class ShopMessage implements IShopMessage {
        constructor(p?: proto.Message.InteractiveMessage.IShopMessage);
        public id?: (string | null);
        public surface?: (proto.Message.InteractiveMessage.ShopMessage.Surface | null);
        public messageVersion?: (number | null);
        public static create(properties?: proto.Message.InteractiveMessage.IShopMessage): proto.Message.InteractiveMessage.ShopMessage;
        public static encode(m: proto.Message.InteractiveMessage.IShopMessage, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveMessage.ShopMessage;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.InteractiveMessage.ShopMessage;
        public static toObject(m: proto.Message.InteractiveMessage.ShopMessage, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace ShopMessage {
        enum Surface {
          UNKNOWN_SURFACE = 0,
          FB = 1,
          IG = 2,
          WA = 3
        }
      }
    }
    interface IInteractiveResponseMessage {
      body?: (proto.Message.InteractiveResponseMessage.IBody | null);
      contextInfo?: (proto.IContextInfo | null);
      nativeFlowResponseMessage?: (proto.Message.InteractiveResponseMessage.INativeFlowResponseMessage | null);
    }
    class InteractiveResponseMessage implements IInteractiveResponseMessage {
      constructor(p?: proto.Message.IInteractiveResponseMessage);
      public body?: (proto.Message.InteractiveResponseMessage.IBody | null);
      public contextInfo?: (proto.IContextInfo | null);
      public nativeFlowResponseMessage?: (proto.Message.InteractiveResponseMessage.INativeFlowResponseMessage | null);
      public interactiveResponseMessage?: "nativeFlowResponseMessage";
      public static create(properties?: proto.Message.IInteractiveResponseMessage): proto.Message.InteractiveResponseMessage;
      public static encode(m: proto.Message.IInteractiveResponseMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveResponseMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.InteractiveResponseMessage;
      public static toObject(m: proto.Message.InteractiveResponseMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace InteractiveResponseMessage {
      interface IBody {
        text?: (string | null);
        format?: (proto.Message.InteractiveResponseMessage.Body.Format | null);
      }
      class Body implements IBody {
        constructor(p?: proto.Message.InteractiveResponseMessage.IBody);
        public text?: (string | null);
        public format?: (proto.Message.InteractiveResponseMessage.Body.Format | null);
        public static create(properties?: proto.Message.InteractiveResponseMessage.IBody): proto.Message.InteractiveResponseMessage.Body;
        public static encode(m: proto.Message.InteractiveResponseMessage.IBody, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveResponseMessage.Body;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.InteractiveResponseMessage.Body;
        public static toObject(m: proto.Message.InteractiveResponseMessage.Body, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace Body {
        enum Format {
          DEFAULT = 0,
          EXTENSIONS_1 = 1
        }
      }
      interface INativeFlowResponseMessage {
        name?: (string | null);
        paramsJson?: (string | null);
        version?: (number | null);
      }
      class NativeFlowResponseMessage implements INativeFlowResponseMessage {
        constructor(p?: proto.Message.InteractiveResponseMessage.INativeFlowResponseMessage);
        public name?: (string | null);
        public paramsJson?: (string | null);
        public version?: (number | null);
        public static create(properties?: proto.Message.InteractiveResponseMessage.INativeFlowResponseMessage): proto.Message.InteractiveResponseMessage.NativeFlowResponseMessage;
        public static encode(m: proto.Message.InteractiveResponseMessage.INativeFlowResponseMessage, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InteractiveResponseMessage.NativeFlowResponseMessage;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.InteractiveResponseMessage.NativeFlowResponseMessage;
        public static toObject(m: proto.Message.InteractiveResponseMessage.NativeFlowResponseMessage, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface IInvoiceMessage {
      note?: (string | null);
      token?: (string | null);
      attachmentType?: (proto.Message.InvoiceMessage.AttachmentType | null);
      attachmentMimetype?: (string | null);
      attachmentMediaKey?: (Uint8Array | null);
      attachmentMediaKeyTimestamp?: (number | Long$1 | null);
      attachmentFileSha256?: (Uint8Array | null);
      attachmentFileEncSha256?: (Uint8Array | null);
      attachmentDirectPath?: (string | null);
      attachmentJpegThumbnail?: (Uint8Array | null);
    }
    class InvoiceMessage implements IInvoiceMessage {
      constructor(p?: proto.Message.IInvoiceMessage);
      public note?: (string | null);
      public token?: (string | null);
      public attachmentType?: (proto.Message.InvoiceMessage.AttachmentType | null);
      public attachmentMimetype?: (string | null);
      public attachmentMediaKey?: (Uint8Array | null);
      public attachmentMediaKeyTimestamp?: (number | Long$1 | null);
      public attachmentFileSha256?: (Uint8Array | null);
      public attachmentFileEncSha256?: (Uint8Array | null);
      public attachmentDirectPath?: (string | null);
      public attachmentJpegThumbnail?: (Uint8Array | null);
      public static create(properties?: proto.Message.IInvoiceMessage): proto.Message.InvoiceMessage;
      public static encode(m: proto.Message.IInvoiceMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.InvoiceMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.InvoiceMessage;
      public static toObject(m: proto.Message.InvoiceMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace InvoiceMessage {
      enum AttachmentType {
        IMAGE = 0,
        PDF = 1
      }
    }
    interface IKeepInChatMessage {
      key?: (proto.IMessageKey | null);
      keepType?: (proto.KeepType | null);
      timestampMs?: (number | Long$1 | null);
    }
    class KeepInChatMessage implements IKeepInChatMessage {
      constructor(p?: proto.Message.IKeepInChatMessage);
      public key?: (proto.IMessageKey | null);
      public keepType?: (proto.KeepType | null);
      public timestampMs?: (number | Long$1 | null);
      public static create(properties?: proto.Message.IKeepInChatMessage): proto.Message.KeepInChatMessage;
      public static encode(m: proto.Message.IKeepInChatMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.KeepInChatMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.KeepInChatMessage;
      public static toObject(m: proto.Message.KeepInChatMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ILinkPreviewMetadata {
      paymentLinkMetadata?: (proto.Message.IPaymentLinkMetadata | null);
      urlMetadata?: (proto.Message.IURLMetadata | null);
      fbExperimentId?: (number | null);
      linkMediaDuration?: (number | null);
      socialMediaPostType?: (proto.Message.LinkPreviewMetadata.SocialMediaPostType | null);
      linkInlineVideoMuted?: (boolean | null);
      videoContentUrl?: (string | null);
      musicMetadata?: (proto.IEmbeddedMusic | null);
      videoContentCaption?: (string | null);
    }
    class LinkPreviewMetadata implements ILinkPreviewMetadata {
      constructor(p?: proto.Message.ILinkPreviewMetadata);
      public paymentLinkMetadata?: (proto.Message.IPaymentLinkMetadata | null);
      public urlMetadata?: (proto.Message.IURLMetadata | null);
      public fbExperimentId?: (number | null);
      public linkMediaDuration?: (number | null);
      public socialMediaPostType?: (proto.Message.LinkPreviewMetadata.SocialMediaPostType | null);
      public linkInlineVideoMuted?: (boolean | null);
      public videoContentUrl?: (string | null);
      public musicMetadata?: (proto.IEmbeddedMusic | null);
      public videoContentCaption?: (string | null);
      public static create(properties?: proto.Message.ILinkPreviewMetadata): proto.Message.LinkPreviewMetadata;
      public static encode(m: proto.Message.ILinkPreviewMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.LinkPreviewMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.LinkPreviewMetadata;
      public static toObject(m: proto.Message.LinkPreviewMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace LinkPreviewMetadata {
      enum SocialMediaPostType {
        NONE = 0,
        REEL = 1,
        LIVE_VIDEO = 2,
        LONG_VIDEO = 3,
        SINGLE_IMAGE = 4,
        CAROUSEL = 5
      }
    }
    interface IListMessage {
      title?: (string | null);
      description?: (string | null);
      buttonText?: (string | null);
      listType?: (proto.Message.ListMessage.ListType | null);
      sections?: (proto.Message.ListMessage.ISection[] | null);
      productListInfo?: (proto.Message.ListMessage.IProductListInfo | null);
      footerText?: (string | null);
      contextInfo?: (proto.IContextInfo | null);
    }
    class ListMessage implements IListMessage {
      constructor(p?: proto.Message.IListMessage);
      public title?: (string | null);
      public description?: (string | null);
      public buttonText?: (string | null);
      public listType?: (proto.Message.ListMessage.ListType | null);
      public sections: proto.Message.ListMessage.ISection[];
      public productListInfo?: (proto.Message.ListMessage.IProductListInfo | null);
      public footerText?: (string | null);
      public contextInfo?: (proto.IContextInfo | null);
      public static create(properties?: proto.Message.IListMessage): proto.Message.ListMessage;
      public static encode(m: proto.Message.IListMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ListMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ListMessage;
      public static toObject(m: proto.Message.ListMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ListMessage {
      enum ListType {
        UNKNOWN = 0,
        SINGLE_SELECT = 1,
        PRODUCT_LIST = 2
      }
      interface IProduct {
        productId?: (string | null);
      }
      class Product implements IProduct {
        constructor(p?: proto.Message.ListMessage.IProduct);
        public productId?: (string | null);
        public static create(properties?: proto.Message.ListMessage.IProduct): proto.Message.ListMessage.Product;
        public static encode(m: proto.Message.ListMessage.IProduct, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ListMessage.Product;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.ListMessage.Product;
        public static toObject(m: proto.Message.ListMessage.Product, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IProductListHeaderImage {
        productId?: (string | null);
        jpegThumbnail?: (Uint8Array | null);
      }
      class ProductListHeaderImage implements IProductListHeaderImage {
        constructor(p?: proto.Message.ListMessage.IProductListHeaderImage);
        public productId?: (string | null);
        public jpegThumbnail?: (Uint8Array | null);
        public static create(properties?: proto.Message.ListMessage.IProductListHeaderImage): proto.Message.ListMessage.ProductListHeaderImage;
        public static encode(m: proto.Message.ListMessage.IProductListHeaderImage, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ListMessage.ProductListHeaderImage;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.ListMessage.ProductListHeaderImage;
        public static toObject(m: proto.Message.ListMessage.ProductListHeaderImage, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IProductListInfo {
        productSections?: (proto.Message.ListMessage.IProductSection[] | null);
        headerImage?: (proto.Message.ListMessage.IProductListHeaderImage | null);
        businessOwnerJid?: (string | null);
      }
      class ProductListInfo implements IProductListInfo {
        constructor(p?: proto.Message.ListMessage.IProductListInfo);
        public productSections: proto.Message.ListMessage.IProductSection[];
        public headerImage?: (proto.Message.ListMessage.IProductListHeaderImage | null);
        public businessOwnerJid?: (string | null);
        public static create(properties?: proto.Message.ListMessage.IProductListInfo): proto.Message.ListMessage.ProductListInfo;
        public static encode(m: proto.Message.ListMessage.IProductListInfo, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ListMessage.ProductListInfo;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.ListMessage.ProductListInfo;
        public static toObject(m: proto.Message.ListMessage.ProductListInfo, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IProductSection {
        title?: (string | null);
        products?: (proto.Message.ListMessage.IProduct[] | null);
      }
      class ProductSection implements IProductSection {
        constructor(p?: proto.Message.ListMessage.IProductSection);
        public title?: (string | null);
        public products: proto.Message.ListMessage.IProduct[];
        public static create(properties?: proto.Message.ListMessage.IProductSection): proto.Message.ListMessage.ProductSection;
        public static encode(m: proto.Message.ListMessage.IProductSection, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ListMessage.ProductSection;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.ListMessage.ProductSection;
        public static toObject(m: proto.Message.ListMessage.ProductSection, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IRow {
        title?: (string | null);
        description?: (string | null);
        rowId?: (string | null);
      }
      class Row implements IRow {
        constructor(p?: proto.Message.ListMessage.IRow);
        public title?: (string | null);
        public description?: (string | null);
        public rowId?: (string | null);
        public static create(properties?: proto.Message.ListMessage.IRow): proto.Message.ListMessage.Row;
        public static encode(m: proto.Message.ListMessage.IRow, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ListMessage.Row;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.ListMessage.Row;
        public static toObject(m: proto.Message.ListMessage.Row, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface ISection {
        title?: (string | null);
        rows?: (proto.Message.ListMessage.IRow[] | null);
      }
      class Section implements ISection {
        constructor(p?: proto.Message.ListMessage.ISection);
        public title?: (string | null);
        public rows: proto.Message.ListMessage.IRow[];
        public static create(properties?: proto.Message.ListMessage.ISection): proto.Message.ListMessage.Section;
        public static encode(m: proto.Message.ListMessage.ISection, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ListMessage.Section;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.ListMessage.Section;
        public static toObject(m: proto.Message.ListMessage.Section, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface IListResponseMessage {
      title?: (string | null);
      listType?: (proto.Message.ListResponseMessage.ListType | null);
      singleSelectReply?: (proto.Message.ListResponseMessage.ISingleSelectReply | null);
      contextInfo?: (proto.IContextInfo | null);
      description?: (string | null);
    }
    class ListResponseMessage implements IListResponseMessage {
      constructor(p?: proto.Message.IListResponseMessage);
      public title?: (string | null);
      public listType?: (proto.Message.ListResponseMessage.ListType | null);
      public singleSelectReply?: (proto.Message.ListResponseMessage.ISingleSelectReply | null);
      public contextInfo?: (proto.IContextInfo | null);
      public description?: (string | null);
      public static create(properties?: proto.Message.IListResponseMessage): proto.Message.ListResponseMessage;
      public static encode(m: proto.Message.IListResponseMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ListResponseMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ListResponseMessage;
      public static toObject(m: proto.Message.ListResponseMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ListResponseMessage {
      enum ListType {
        UNKNOWN = 0,
        SINGLE_SELECT = 1
      }
      interface ISingleSelectReply {
        selectedRowId?: (string | null);
      }
      class SingleSelectReply implements ISingleSelectReply {
        constructor(p?: proto.Message.ListResponseMessage.ISingleSelectReply);
        public selectedRowId?: (string | null);
        public static create(properties?: proto.Message.ListResponseMessage.ISingleSelectReply): proto.Message.ListResponseMessage.SingleSelectReply;
        public static encode(m: proto.Message.ListResponseMessage.ISingleSelectReply, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ListResponseMessage.SingleSelectReply;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.ListResponseMessage.SingleSelectReply;
        public static toObject(m: proto.Message.ListResponseMessage.SingleSelectReply, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface ILiveLocationMessage {
      degreesLatitude?: (number | null);
      degreesLongitude?: (number | null);
      accuracyInMeters?: (number | null);
      speedInMps?: (number | null);
      degreesClockwiseFromMagneticNorth?: (number | null);
      caption?: (string | null);
      sequenceNumber?: (number | Long$1 | null);
      timeOffset?: (number | null);
      jpegThumbnail?: (Uint8Array | null);
      contextInfo?: (proto.IContextInfo | null);
    }
    class LiveLocationMessage implements ILiveLocationMessage {
      constructor(p?: proto.Message.ILiveLocationMessage);
      public degreesLatitude?: (number | null);
      public degreesLongitude?: (number | null);
      public accuracyInMeters?: (number | null);
      public speedInMps?: (number | null);
      public degreesClockwiseFromMagneticNorth?: (number | null);
      public caption?: (string | null);
      public sequenceNumber?: (number | Long$1 | null);
      public timeOffset?: (number | null);
      public jpegThumbnail?: (Uint8Array | null);
      public contextInfo?: (proto.IContextInfo | null);
      public static create(properties?: proto.Message.ILiveLocationMessage): proto.Message.LiveLocationMessage;
      public static encode(m: proto.Message.ILiveLocationMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.LiveLocationMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.LiveLocationMessage;
      public static toObject(m: proto.Message.LiveLocationMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ILocationMessage {
      degreesLatitude?: (number | null);
      degreesLongitude?: (number | null);
      name?: (string | null);
      address?: (string | null);
      url?: (string | null);
      isLive?: (boolean | null);
      accuracyInMeters?: (number | null);
      speedInMps?: (number | null);
      degreesClockwiseFromMagneticNorth?: (number | null);
      comment?: (string | null);
      jpegThumbnail?: (Uint8Array | null);
      contextInfo?: (proto.IContextInfo | null);
    }
    class LocationMessage implements ILocationMessage {
      constructor(p?: proto.Message.ILocationMessage);
      public degreesLatitude?: (number | null);
      public degreesLongitude?: (number | null);
      public name?: (string | null);
      public address?: (string | null);
      public url?: (string | null);
      public isLive?: (boolean | null);
      public accuracyInMeters?: (number | null);
      public speedInMps?: (number | null);
      public degreesClockwiseFromMagneticNorth?: (number | null);
      public comment?: (string | null);
      public jpegThumbnail?: (Uint8Array | null);
      public contextInfo?: (proto.IContextInfo | null);
      public static create(properties?: proto.Message.ILocationMessage): proto.Message.LocationMessage;
      public static encode(m: proto.Message.ILocationMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.LocationMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.LocationMessage;
      public static toObject(m: proto.Message.LocationMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IMMSThumbnailMetadata {
      thumbnailDirectPath?: (string | null);
      thumbnailSha256?: (Uint8Array | null);
      thumbnailEncSha256?: (Uint8Array | null);
      mediaKey?: (Uint8Array | null);
      mediaKeyTimestamp?: (number | Long$1 | null);
      thumbnailHeight?: (number | null);
      thumbnailWidth?: (number | null);
      mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
    }
    class MMSThumbnailMetadata implements IMMSThumbnailMetadata {
      constructor(p?: proto.Message.IMMSThumbnailMetadata);
      public thumbnailDirectPath?: (string | null);
      public thumbnailSha256?: (Uint8Array | null);
      public thumbnailEncSha256?: (Uint8Array | null);
      public mediaKey?: (Uint8Array | null);
      public mediaKeyTimestamp?: (number | Long$1 | null);
      public thumbnailHeight?: (number | null);
      public thumbnailWidth?: (number | null);
      public mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
      public static create(properties?: proto.Message.IMMSThumbnailMetadata): proto.Message.MMSThumbnailMetadata;
      public static encode(m: proto.Message.IMMSThumbnailMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.MMSThumbnailMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.MMSThumbnailMetadata;
      public static toObject(m: proto.Message.MMSThumbnailMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum MediaKeyDomain {
      UNSET = 0,
      E2EE_CHAT = 1,
      STATUS = 2,
      CAPI = 3,
      BOT = 4
    }
    interface IMessageHistoryBundle {
      mimetype?: (string | null);
      fileSha256?: (Uint8Array | null);
      mediaKey?: (Uint8Array | null);
      fileEncSha256?: (Uint8Array | null);
      directPath?: (string | null);
      mediaKeyTimestamp?: (number | Long$1 | null);
      contextInfo?: (proto.IContextInfo | null);
      messageHistoryMetadata?: (proto.Message.IMessageHistoryMetadata | null);
    }
    class MessageHistoryBundle implements IMessageHistoryBundle {
      constructor(p?: proto.Message.IMessageHistoryBundle);
      public mimetype?: (string | null);
      public fileSha256?: (Uint8Array | null);
      public mediaKey?: (Uint8Array | null);
      public fileEncSha256?: (Uint8Array | null);
      public directPath?: (string | null);
      public mediaKeyTimestamp?: (number | Long$1 | null);
      public contextInfo?: (proto.IContextInfo | null);
      public messageHistoryMetadata?: (proto.Message.IMessageHistoryMetadata | null);
      public static create(properties?: proto.Message.IMessageHistoryBundle): proto.Message.MessageHistoryBundle;
      public static encode(m: proto.Message.IMessageHistoryBundle, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.MessageHistoryBundle;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.MessageHistoryBundle;
      public static toObject(m: proto.Message.MessageHistoryBundle, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IMessageHistoryMetadata {
      historyReceivers?: (string[] | null);
      oldestMessageTimestamp?: (number | Long$1 | null);
      messageCount?: (number | Long$1 | null);
    }
    class MessageHistoryMetadata implements IMessageHistoryMetadata {
      constructor(p?: proto.Message.IMessageHistoryMetadata);
      public historyReceivers: string[];
      public oldestMessageTimestamp?: (number | Long$1 | null);
      public messageCount?: (number | Long$1 | null);
      public static create(properties?: proto.Message.IMessageHistoryMetadata): proto.Message.MessageHistoryMetadata;
      public static encode(m: proto.Message.IMessageHistoryMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.MessageHistoryMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.MessageHistoryMetadata;
      public static toObject(m: proto.Message.MessageHistoryMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IMessageHistoryNotice {
      contextInfo?: (proto.IContextInfo | null);
      messageHistoryMetadata?: (proto.Message.IMessageHistoryMetadata | null);
    }
    class MessageHistoryNotice implements IMessageHistoryNotice {
      constructor(p?: proto.Message.IMessageHistoryNotice);
      public contextInfo?: (proto.IContextInfo | null);
      public messageHistoryMetadata?: (proto.Message.IMessageHistoryMetadata | null);
      public static create(properties?: proto.Message.IMessageHistoryNotice): proto.Message.MessageHistoryNotice;
      public static encode(m: proto.Message.IMessageHistoryNotice, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.MessageHistoryNotice;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.MessageHistoryNotice;
      public static toObject(m: proto.Message.MessageHistoryNotice, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface INewsletterAdminInviteMessage {
      newsletterJid?: (string | null);
      newsletterName?: (string | null);
      jpegThumbnail?: (Uint8Array | null);
      caption?: (string | null);
      inviteExpiration?: (number | Long$1 | null);
      contextInfo?: (proto.IContextInfo | null);
    }
    class NewsletterAdminInviteMessage implements INewsletterAdminInviteMessage {
      constructor(p?: proto.Message.INewsletterAdminInviteMessage);
      public newsletterJid?: (string | null);
      public newsletterName?: (string | null);
      public jpegThumbnail?: (Uint8Array | null);
      public caption?: (string | null);
      public inviteExpiration?: (number | Long$1 | null);
      public contextInfo?: (proto.IContextInfo | null);
      public static create(properties?: proto.Message.INewsletterAdminInviteMessage): proto.Message.NewsletterAdminInviteMessage;
      public static encode(m: proto.Message.INewsletterAdminInviteMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.NewsletterAdminInviteMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.NewsletterAdminInviteMessage;
      public static toObject(m: proto.Message.NewsletterAdminInviteMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface INewsletterFollowerInviteMessage {
      newsletterJid?: (string | null);
      newsletterName?: (string | null);
      jpegThumbnail?: (Uint8Array | null);
      caption?: (string | null);
      contextInfo?: (proto.IContextInfo | null);
    }
    class NewsletterFollowerInviteMessage implements INewsletterFollowerInviteMessage {
      constructor(p?: proto.Message.INewsletterFollowerInviteMessage);
      public newsletterJid?: (string | null);
      public newsletterName?: (string | null);
      public jpegThumbnail?: (Uint8Array | null);
      public caption?: (string | null);
      public contextInfo?: (proto.IContextInfo | null);
      public static create(properties?: proto.Message.INewsletterFollowerInviteMessage): proto.Message.NewsletterFollowerInviteMessage;
      public static encode(m: proto.Message.INewsletterFollowerInviteMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.NewsletterFollowerInviteMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.NewsletterFollowerInviteMessage;
      public static toObject(m: proto.Message.NewsletterFollowerInviteMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IOrderMessage {
      orderId?: (string | null);
      thumbnail?: (Uint8Array | null);
      itemCount?: (number | null);
      status?: (proto.Message.OrderMessage.OrderStatus | null);
      surface?: (proto.Message.OrderMessage.OrderSurface | null);
      message?: (string | null);
      orderTitle?: (string | null);
      sellerJid?: (string | null);
      token?: (string | null);
      totalAmount1000?: (number | Long$1 | null);
      totalCurrencyCode?: (string | null);
      contextInfo?: (proto.IContextInfo | null);
      messageVersion?: (number | null);
      orderRequestMessageId?: (proto.IMessageKey | null);
      catalogType?: (string | null);
    }
    class OrderMessage implements IOrderMessage {
      constructor(p?: proto.Message.IOrderMessage);
      public orderId?: (string | null);
      public thumbnail?: (Uint8Array | null);
      public itemCount?: (number | null);
      public status?: (proto.Message.OrderMessage.OrderStatus | null);
      public surface?: (proto.Message.OrderMessage.OrderSurface | null);
      public message?: (string | null);
      public orderTitle?: (string | null);
      public sellerJid?: (string | null);
      public token?: (string | null);
      public totalAmount1000?: (number | Long$1 | null);
      public totalCurrencyCode?: (string | null);
      public contextInfo?: (proto.IContextInfo | null);
      public messageVersion?: (number | null);
      public orderRequestMessageId?: (proto.IMessageKey | null);
      public catalogType?: (string | null);
      public static create(properties?: proto.Message.IOrderMessage): proto.Message.OrderMessage;
      public static encode(m: proto.Message.IOrderMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.OrderMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.OrderMessage;
      public static toObject(m: proto.Message.OrderMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace OrderMessage {
      enum OrderStatus {
        INQUIRY = 1,
        ACCEPTED = 2,
        DECLINED = 3
      }
      enum OrderSurface {
        CATALOG = 1
      }
    }
    interface IPaymentExtendedMetadata {
      type?: (number | null);
      platform?: (string | null);
      messageParamsJson?: (string | null);
    }
    class PaymentExtendedMetadata implements IPaymentExtendedMetadata {
      constructor(p?: proto.Message.IPaymentExtendedMetadata);
      public type?: (number | null);
      public platform?: (string | null);
      public messageParamsJson?: (string | null);
      public static create(properties?: proto.Message.IPaymentExtendedMetadata): proto.Message.PaymentExtendedMetadata;
      public static encode(m: proto.Message.IPaymentExtendedMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PaymentExtendedMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PaymentExtendedMetadata;
      public static toObject(m: proto.Message.PaymentExtendedMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPaymentInviteMessage {
      serviceType?: (proto.Message.PaymentInviteMessage.ServiceType | null);
      expiryTimestamp?: (number | Long$1 | null);
    }
    class PaymentInviteMessage implements IPaymentInviteMessage {
      constructor(p?: proto.Message.IPaymentInviteMessage);
      public serviceType?: (proto.Message.PaymentInviteMessage.ServiceType | null);
      public expiryTimestamp?: (number | Long$1 | null);
      public static create(properties?: proto.Message.IPaymentInviteMessage): proto.Message.PaymentInviteMessage;
      public static encode(m: proto.Message.IPaymentInviteMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PaymentInviteMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PaymentInviteMessage;
      public static toObject(m: proto.Message.PaymentInviteMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace PaymentInviteMessage {
      enum ServiceType {
        UNKNOWN = 0,
        FBPAY = 1,
        NOVI = 2,
        UPI = 3
      }
    }
    interface IPaymentLinkMetadata {
      button?: (proto.Message.PaymentLinkMetadata.IPaymentLinkButton | null);
      header?: (proto.Message.PaymentLinkMetadata.IPaymentLinkHeader | null);
      provider?: (proto.Message.PaymentLinkMetadata.IPaymentLinkProvider | null);
    }
    class PaymentLinkMetadata implements IPaymentLinkMetadata {
      constructor(p?: proto.Message.IPaymentLinkMetadata);
      public button?: (proto.Message.PaymentLinkMetadata.IPaymentLinkButton | null);
      public header?: (proto.Message.PaymentLinkMetadata.IPaymentLinkHeader | null);
      public provider?: (proto.Message.PaymentLinkMetadata.IPaymentLinkProvider | null);
      public static create(properties?: proto.Message.IPaymentLinkMetadata): proto.Message.PaymentLinkMetadata;
      public static encode(m: proto.Message.IPaymentLinkMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PaymentLinkMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PaymentLinkMetadata;
      public static toObject(m: proto.Message.PaymentLinkMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace PaymentLinkMetadata {
      interface IPaymentLinkButton {
        displayText?: (string | null);
      }
      class PaymentLinkButton implements IPaymentLinkButton {
        constructor(p?: proto.Message.PaymentLinkMetadata.IPaymentLinkButton);
        public displayText?: (string | null);
        public static create(properties?: proto.Message.PaymentLinkMetadata.IPaymentLinkButton): proto.Message.PaymentLinkMetadata.PaymentLinkButton;
        public static encode(m: proto.Message.PaymentLinkMetadata.IPaymentLinkButton, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PaymentLinkMetadata.PaymentLinkButton;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PaymentLinkMetadata.PaymentLinkButton;
        public static toObject(m: proto.Message.PaymentLinkMetadata.PaymentLinkButton, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IPaymentLinkHeader {
        headerType?: (proto.Message.PaymentLinkMetadata.PaymentLinkHeader.PaymentLinkHeaderType | null);
      }
      class PaymentLinkHeader implements IPaymentLinkHeader {
        constructor(p?: proto.Message.PaymentLinkMetadata.IPaymentLinkHeader);
        public headerType?: (proto.Message.PaymentLinkMetadata.PaymentLinkHeader.PaymentLinkHeaderType | null);
        public static create(properties?: proto.Message.PaymentLinkMetadata.IPaymentLinkHeader): proto.Message.PaymentLinkMetadata.PaymentLinkHeader;
        public static encode(m: proto.Message.PaymentLinkMetadata.IPaymentLinkHeader, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PaymentLinkMetadata.PaymentLinkHeader;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PaymentLinkMetadata.PaymentLinkHeader;
        public static toObject(m: proto.Message.PaymentLinkMetadata.PaymentLinkHeader, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace PaymentLinkHeader {
        enum PaymentLinkHeaderType {
          LINK_PREVIEW = 0,
          ORDER = 1
        }
      }
      interface IPaymentLinkProvider {
        paramsJson?: (string | null);
      }
      class PaymentLinkProvider implements IPaymentLinkProvider {
        constructor(p?: proto.Message.PaymentLinkMetadata.IPaymentLinkProvider);
        public paramsJson?: (string | null);
        public static create(properties?: proto.Message.PaymentLinkMetadata.IPaymentLinkProvider): proto.Message.PaymentLinkMetadata.PaymentLinkProvider;
        public static encode(m: proto.Message.PaymentLinkMetadata.IPaymentLinkProvider, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PaymentLinkMetadata.PaymentLinkProvider;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PaymentLinkMetadata.PaymentLinkProvider;
        public static toObject(m: proto.Message.PaymentLinkMetadata.PaymentLinkProvider, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface IPeerDataOperationRequestMessage {
      peerDataOperationRequestType?: (proto.Message.PeerDataOperationRequestType | null);
      requestStickerReupload?: (proto.Message.PeerDataOperationRequestMessage.IRequestStickerReupload[] | null);
      requestUrlPreview?: (proto.Message.PeerDataOperationRequestMessage.IRequestUrlPreview[] | null);
      historySyncOnDemandRequest?: (proto.Message.PeerDataOperationRequestMessage.IHistorySyncOnDemandRequest | null);
      placeholderMessageResendRequest?: (proto.Message.PeerDataOperationRequestMessage.IPlaceholderMessageResendRequest[] | null);
      fullHistorySyncOnDemandRequest?: (proto.Message.PeerDataOperationRequestMessage.IFullHistorySyncOnDemandRequest | null);
      syncdCollectionFatalRecoveryRequest?: (proto.Message.PeerDataOperationRequestMessage.ISyncDCollectionFatalRecoveryRequest | null);
      historySyncChunkRetryRequest?: (proto.Message.PeerDataOperationRequestMessage.IHistorySyncChunkRetryRequest | null);
      galaxyFlowAction?: (proto.Message.PeerDataOperationRequestMessage.IGalaxyFlowAction | null);
    }
    class PeerDataOperationRequestMessage implements IPeerDataOperationRequestMessage {
      constructor(p?: proto.Message.IPeerDataOperationRequestMessage);
      public peerDataOperationRequestType?: (proto.Message.PeerDataOperationRequestType | null);
      public requestStickerReupload: proto.Message.PeerDataOperationRequestMessage.IRequestStickerReupload[];
      public requestUrlPreview: proto.Message.PeerDataOperationRequestMessage.IRequestUrlPreview[];
      public historySyncOnDemandRequest?: (proto.Message.PeerDataOperationRequestMessage.IHistorySyncOnDemandRequest | null);
      public placeholderMessageResendRequest: proto.Message.PeerDataOperationRequestMessage.IPlaceholderMessageResendRequest[];
      public fullHistorySyncOnDemandRequest?: (proto.Message.PeerDataOperationRequestMessage.IFullHistorySyncOnDemandRequest | null);
      public syncdCollectionFatalRecoveryRequest?: (proto.Message.PeerDataOperationRequestMessage.ISyncDCollectionFatalRecoveryRequest | null);
      public historySyncChunkRetryRequest?: (proto.Message.PeerDataOperationRequestMessage.IHistorySyncChunkRetryRequest | null);
      public galaxyFlowAction?: (proto.Message.PeerDataOperationRequestMessage.IGalaxyFlowAction | null);
      public static create(properties?: proto.Message.IPeerDataOperationRequestMessage): proto.Message.PeerDataOperationRequestMessage;
      public static encode(m: proto.Message.IPeerDataOperationRequestMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PeerDataOperationRequestMessage;
      public static toObject(m: proto.Message.PeerDataOperationRequestMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace PeerDataOperationRequestMessage {
      interface IFullHistorySyncOnDemandRequest {
        requestMetadata?: (proto.Message.IFullHistorySyncOnDemandRequestMetadata | null);
        historySyncConfig?: (proto.DeviceProps.IHistorySyncConfig | null);
      }
      class FullHistorySyncOnDemandRequest implements IFullHistorySyncOnDemandRequest {
        constructor(p?: proto.Message.PeerDataOperationRequestMessage.IFullHistorySyncOnDemandRequest);
        public requestMetadata?: (proto.Message.IFullHistorySyncOnDemandRequestMetadata | null);
        public historySyncConfig?: (proto.DeviceProps.IHistorySyncConfig | null);
        public static create(properties?: proto.Message.PeerDataOperationRequestMessage.IFullHistorySyncOnDemandRequest): proto.Message.PeerDataOperationRequestMessage.FullHistorySyncOnDemandRequest;
        public static encode(m: proto.Message.PeerDataOperationRequestMessage.IFullHistorySyncOnDemandRequest, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestMessage.FullHistorySyncOnDemandRequest;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PeerDataOperationRequestMessage.FullHistorySyncOnDemandRequest;
        public static toObject(m: proto.Message.PeerDataOperationRequestMessage.FullHistorySyncOnDemandRequest, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IGalaxyFlowAction {
        type?: (proto.Message.PeerDataOperationRequestMessage.GalaxyFlowAction.GalaxyFlowActionType | null);
        flowId?: (string | null);
        stanzaId?: (string | null);
      }
      class GalaxyFlowAction implements IGalaxyFlowAction {
        constructor(p?: proto.Message.PeerDataOperationRequestMessage.IGalaxyFlowAction);
        public type?: (proto.Message.PeerDataOperationRequestMessage.GalaxyFlowAction.GalaxyFlowActionType | null);
        public flowId?: (string | null);
        public stanzaId?: (string | null);
        public static create(properties?: proto.Message.PeerDataOperationRequestMessage.IGalaxyFlowAction): proto.Message.PeerDataOperationRequestMessage.GalaxyFlowAction;
        public static encode(m: proto.Message.PeerDataOperationRequestMessage.IGalaxyFlowAction, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestMessage.GalaxyFlowAction;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PeerDataOperationRequestMessage.GalaxyFlowAction;
        public static toObject(m: proto.Message.PeerDataOperationRequestMessage.GalaxyFlowAction, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace GalaxyFlowAction {
        enum GalaxyFlowActionType {
          NOTIFY_LAUNCH = 1
        }
      }
      interface IHistorySyncChunkRetryRequest {
        syncType?: (proto.Message.HistorySyncType | null);
        chunkOrder?: (number | null);
        chunkNotificationId?: (string | null);
        regenerateChunk?: (boolean | null);
      }
      class HistorySyncChunkRetryRequest implements IHistorySyncChunkRetryRequest {
        constructor(p?: proto.Message.PeerDataOperationRequestMessage.IHistorySyncChunkRetryRequest);
        public syncType?: (proto.Message.HistorySyncType | null);
        public chunkOrder?: (number | null);
        public chunkNotificationId?: (string | null);
        public regenerateChunk?: (boolean | null);
        public static create(properties?: proto.Message.PeerDataOperationRequestMessage.IHistorySyncChunkRetryRequest): proto.Message.PeerDataOperationRequestMessage.HistorySyncChunkRetryRequest;
        public static encode(m: proto.Message.PeerDataOperationRequestMessage.IHistorySyncChunkRetryRequest, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestMessage.HistorySyncChunkRetryRequest;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PeerDataOperationRequestMessage.HistorySyncChunkRetryRequest;
        public static toObject(m: proto.Message.PeerDataOperationRequestMessage.HistorySyncChunkRetryRequest, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IHistorySyncOnDemandRequest {
        chatJid?: (string | null);
        oldestMsgId?: (string | null);
        oldestMsgFromMe?: (boolean | null);
        onDemandMsgCount?: (number | null);
        oldestMsgTimestampMs?: (number | Long$1 | null);
        accountLid?: (string | null);
      }
      class HistorySyncOnDemandRequest implements IHistorySyncOnDemandRequest {
        constructor(p?: proto.Message.PeerDataOperationRequestMessage.IHistorySyncOnDemandRequest);
        public chatJid?: (string | null);
        public oldestMsgId?: (string | null);
        public oldestMsgFromMe?: (boolean | null);
        public onDemandMsgCount?: (number | null);
        public oldestMsgTimestampMs?: (number | Long$1 | null);
        public accountLid?: (string | null);
        public static create(properties?: proto.Message.PeerDataOperationRequestMessage.IHistorySyncOnDemandRequest): proto.Message.PeerDataOperationRequestMessage.HistorySyncOnDemandRequest;
        public static encode(m: proto.Message.PeerDataOperationRequestMessage.IHistorySyncOnDemandRequest, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestMessage.HistorySyncOnDemandRequest;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PeerDataOperationRequestMessage.HistorySyncOnDemandRequest;
        public static toObject(m: proto.Message.PeerDataOperationRequestMessage.HistorySyncOnDemandRequest, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IPlaceholderMessageResendRequest {
        messageKey?: (proto.IMessageKey | null);
      }
      class PlaceholderMessageResendRequest implements IPlaceholderMessageResendRequest {
        constructor(p?: proto.Message.PeerDataOperationRequestMessage.IPlaceholderMessageResendRequest);
        public messageKey?: (proto.IMessageKey | null);
        public static create(properties?: proto.Message.PeerDataOperationRequestMessage.IPlaceholderMessageResendRequest): proto.Message.PeerDataOperationRequestMessage.PlaceholderMessageResendRequest;
        public static encode(m: proto.Message.PeerDataOperationRequestMessage.IPlaceholderMessageResendRequest, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestMessage.PlaceholderMessageResendRequest;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PeerDataOperationRequestMessage.PlaceholderMessageResendRequest;
        public static toObject(m: proto.Message.PeerDataOperationRequestMessage.PlaceholderMessageResendRequest, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IRequestStickerReupload {
        fileSha256?: (string | null);
      }
      class RequestStickerReupload implements IRequestStickerReupload {
        constructor(p?: proto.Message.PeerDataOperationRequestMessage.IRequestStickerReupload);
        public fileSha256?: (string | null);
        public static create(properties?: proto.Message.PeerDataOperationRequestMessage.IRequestStickerReupload): proto.Message.PeerDataOperationRequestMessage.RequestStickerReupload;
        public static encode(m: proto.Message.PeerDataOperationRequestMessage.IRequestStickerReupload, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestMessage.RequestStickerReupload;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PeerDataOperationRequestMessage.RequestStickerReupload;
        public static toObject(m: proto.Message.PeerDataOperationRequestMessage.RequestStickerReupload, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IRequestUrlPreview {
        url?: (string | null);
        includeHqThumbnail?: (boolean | null);
      }
      class RequestUrlPreview implements IRequestUrlPreview {
        constructor(p?: proto.Message.PeerDataOperationRequestMessage.IRequestUrlPreview);
        public url?: (string | null);
        public includeHqThumbnail?: (boolean | null);
        public static create(properties?: proto.Message.PeerDataOperationRequestMessage.IRequestUrlPreview): proto.Message.PeerDataOperationRequestMessage.RequestUrlPreview;
        public static encode(m: proto.Message.PeerDataOperationRequestMessage.IRequestUrlPreview, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestMessage.RequestUrlPreview;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PeerDataOperationRequestMessage.RequestUrlPreview;
        public static toObject(m: proto.Message.PeerDataOperationRequestMessage.RequestUrlPreview, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface ISyncDCollectionFatalRecoveryRequest {
        collectionName?: (string | null);
        timestamp?: (number | Long$1 | null);
      }
      class SyncDCollectionFatalRecoveryRequest implements ISyncDCollectionFatalRecoveryRequest {
        constructor(p?: proto.Message.PeerDataOperationRequestMessage.ISyncDCollectionFatalRecoveryRequest);
        public collectionName?: (string | null);
        public timestamp?: (number | Long$1 | null);
        public static create(properties?: proto.Message.PeerDataOperationRequestMessage.ISyncDCollectionFatalRecoveryRequest): proto.Message.PeerDataOperationRequestMessage.SyncDCollectionFatalRecoveryRequest;
        public static encode(m: proto.Message.PeerDataOperationRequestMessage.ISyncDCollectionFatalRecoveryRequest, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestMessage.SyncDCollectionFatalRecoveryRequest;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PeerDataOperationRequestMessage.SyncDCollectionFatalRecoveryRequest;
        public static toObject(m: proto.Message.PeerDataOperationRequestMessage.SyncDCollectionFatalRecoveryRequest, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface IPeerDataOperationRequestResponseMessage {
      peerDataOperationRequestType?: (proto.Message.PeerDataOperationRequestType | null);
      stanzaId?: (string | null);
      peerDataOperationResult?: (proto.Message.PeerDataOperationRequestResponseMessage.IPeerDataOperationResult[] | null);
    }
    class PeerDataOperationRequestResponseMessage implements IPeerDataOperationRequestResponseMessage {
      constructor(p?: proto.Message.IPeerDataOperationRequestResponseMessage);
      public peerDataOperationRequestType?: (proto.Message.PeerDataOperationRequestType | null);
      public stanzaId?: (string | null);
      public peerDataOperationResult: proto.Message.PeerDataOperationRequestResponseMessage.IPeerDataOperationResult[];
      public static create(properties?: proto.Message.IPeerDataOperationRequestResponseMessage): proto.Message.PeerDataOperationRequestResponseMessage;
      public static encode(m: proto.Message.IPeerDataOperationRequestResponseMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PeerDataOperationRequestResponseMessage;
      public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace PeerDataOperationRequestResponseMessage {
      interface IPeerDataOperationResult {
        mediaUploadResult?: (proto.MediaRetryNotification.ResultType | null);
        stickerMessage?: (proto.Message.IStickerMessage | null);
        linkPreviewResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ILinkPreviewResponse | null);
        placeholderMessageResendResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IPlaceholderMessageResendResponse | null);
        waffleNonceFetchRequestResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IWaffleNonceFetchResponse | null);
        fullHistorySyncOnDemandRequestResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IFullHistorySyncOnDemandRequestResponse | null);
        companionMetaNonceFetchRequestResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ICompanionMetaNonceFetchResponse | null);
        syncdSnapshotFatalRecoveryResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ISyncDSnapshotFatalRecoveryResponse | null);
        companionCanonicalUserNonceFetchRequestResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ICompanionCanonicalUserNonceFetchResponse | null);
        historySyncChunkRetryResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IHistorySyncChunkRetryResponse | null);
      }
      class PeerDataOperationResult implements IPeerDataOperationResult {
        constructor(p?: proto.Message.PeerDataOperationRequestResponseMessage.IPeerDataOperationResult);
        public mediaUploadResult?: (proto.MediaRetryNotification.ResultType | null);
        public stickerMessage?: (proto.Message.IStickerMessage | null);
        public linkPreviewResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ILinkPreviewResponse | null);
        public placeholderMessageResendResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IPlaceholderMessageResendResponse | null);
        public waffleNonceFetchRequestResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IWaffleNonceFetchResponse | null);
        public fullHistorySyncOnDemandRequestResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IFullHistorySyncOnDemandRequestResponse | null);
        public companionMetaNonceFetchRequestResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ICompanionMetaNonceFetchResponse | null);
        public syncdSnapshotFatalRecoveryResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ISyncDSnapshotFatalRecoveryResponse | null);
        public companionCanonicalUserNonceFetchRequestResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ICompanionCanonicalUserNonceFetchResponse | null);
        public historySyncChunkRetryResponse?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IHistorySyncChunkRetryResponse | null);
        public static create(properties?: proto.Message.PeerDataOperationRequestResponseMessage.IPeerDataOperationResult): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult;
        public static encode(m: proto.Message.PeerDataOperationRequestResponseMessage.IPeerDataOperationResult, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult;
        public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      namespace PeerDataOperationResult {
        interface ICompanionCanonicalUserNonceFetchResponse {
          nonce?: (string | null);
          waFbid?: (string | null);
          forceRefresh?: (boolean | null);
        }
        class CompanionCanonicalUserNonceFetchResponse implements ICompanionCanonicalUserNonceFetchResponse {
          constructor(p?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ICompanionCanonicalUserNonceFetchResponse);
          public nonce?: (string | null);
          public waFbid?: (string | null);
          public forceRefresh?: (boolean | null);
          public static create(properties?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ICompanionCanonicalUserNonceFetchResponse): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.CompanionCanonicalUserNonceFetchResponse;
          public static encode(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ICompanionCanonicalUserNonceFetchResponse, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.CompanionCanonicalUserNonceFetchResponse;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.CompanionCanonicalUserNonceFetchResponse;
          public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.CompanionCanonicalUserNonceFetchResponse, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        interface ICompanionMetaNonceFetchResponse {
          nonce?: (string | null);
        }
        class CompanionMetaNonceFetchResponse implements ICompanionMetaNonceFetchResponse {
          constructor(p?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ICompanionMetaNonceFetchResponse);
          public nonce?: (string | null);
          public static create(properties?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ICompanionMetaNonceFetchResponse): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.CompanionMetaNonceFetchResponse;
          public static encode(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ICompanionMetaNonceFetchResponse, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.CompanionMetaNonceFetchResponse;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.CompanionMetaNonceFetchResponse;
          public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.CompanionMetaNonceFetchResponse, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        interface IFullHistorySyncOnDemandRequestResponse {
          requestMetadata?: (proto.Message.IFullHistorySyncOnDemandRequestMetadata | null);
          responseCode?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.FullHistorySyncOnDemandResponseCode | null);
        }
        class FullHistorySyncOnDemandRequestResponse implements IFullHistorySyncOnDemandRequestResponse {
          constructor(p?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IFullHistorySyncOnDemandRequestResponse);
          public requestMetadata?: (proto.Message.IFullHistorySyncOnDemandRequestMetadata | null);
          public responseCode?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.FullHistorySyncOnDemandResponseCode | null);
          public static create(properties?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IFullHistorySyncOnDemandRequestResponse): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.FullHistorySyncOnDemandRequestResponse;
          public static encode(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IFullHistorySyncOnDemandRequestResponse, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.FullHistorySyncOnDemandRequestResponse;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.FullHistorySyncOnDemandRequestResponse;
          public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.FullHistorySyncOnDemandRequestResponse, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        enum FullHistorySyncOnDemandResponseCode {
          REQUEST_SUCCESS = 0,
          REQUEST_TIME_EXPIRED = 1,
          DECLINED_SHARING_HISTORY = 2,
          GENERIC_ERROR = 3,
          ERROR_REQUEST_ON_NON_SMB_PRIMARY = 4,
          ERROR_HOSTED_DEVICE_NOT_CONNECTED = 5,
          ERROR_HOSTED_DEVICE_LOGIN_TIME_NOT_SET = 6
        }
        interface IHistorySyncChunkRetryResponse {
          syncType?: (proto.Message.HistorySyncType | null);
          chunkOrder?: (number | null);
          requestId?: (string | null);
          responseCode?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.HistorySyncChunkRetryResponseCode | null);
          canRecover?: (boolean | null);
        }
        class HistorySyncChunkRetryResponse implements IHistorySyncChunkRetryResponse {
          constructor(p?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IHistorySyncChunkRetryResponse);
          public syncType?: (proto.Message.HistorySyncType | null);
          public chunkOrder?: (number | null);
          public requestId?: (string | null);
          public responseCode?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.HistorySyncChunkRetryResponseCode | null);
          public canRecover?: (boolean | null);
          public static create(properties?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IHistorySyncChunkRetryResponse): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.HistorySyncChunkRetryResponse;
          public static encode(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IHistorySyncChunkRetryResponse, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.HistorySyncChunkRetryResponse;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.HistorySyncChunkRetryResponse;
          public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.HistorySyncChunkRetryResponse, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        enum HistorySyncChunkRetryResponseCode {
          GENERATION_ERROR = 1,
          CHUNK_CONSUMED = 2,
          TIMEOUT = 3,
          SESSION_EXHAUSTED = 4,
          CHUNK_EXHAUSTED = 5,
          DUPLICATED_REQUEST = 6
        }
        interface ILinkPreviewResponse {
          url?: (string | null);
          title?: (string | null);
          description?: (string | null);
          thumbData?: (Uint8Array | null);
          matchText?: (string | null);
          previewType?: (string | null);
          hqThumbnail?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.ILinkPreviewHighQualityThumbnail | null);
          previewMetadata?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.IPaymentLinkPreviewMetadata | null);
        }
        class LinkPreviewResponse implements ILinkPreviewResponse {
          constructor(p?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ILinkPreviewResponse);
          public url?: (string | null);
          public title?: (string | null);
          public description?: (string | null);
          public thumbData?: (Uint8Array | null);
          public matchText?: (string | null);
          public previewType?: (string | null);
          public hqThumbnail?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.ILinkPreviewHighQualityThumbnail | null);
          public previewMetadata?: (proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.IPaymentLinkPreviewMetadata | null);
          public static create(properties?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ILinkPreviewResponse): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse;
          public static encode(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ILinkPreviewResponse, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse;
          public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        namespace LinkPreviewResponse {
          interface ILinkPreviewHighQualityThumbnail {
            directPath?: (string | null);
            thumbHash?: (string | null);
            encThumbHash?: (string | null);
            mediaKey?: (Uint8Array | null);
            mediaKeyTimestampMs?: (number | Long$1 | null);
            thumbWidth?: (number | null);
            thumbHeight?: (number | null);
          }
          class LinkPreviewHighQualityThumbnail implements ILinkPreviewHighQualityThumbnail {
            constructor(p?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.ILinkPreviewHighQualityThumbnail);
            public directPath?: (string | null);
            public thumbHash?: (string | null);
            public encThumbHash?: (string | null);
            public mediaKey?: (Uint8Array | null);
            public mediaKeyTimestampMs?: (number | Long$1 | null);
            public thumbWidth?: (number | null);
            public thumbHeight?: (number | null);
            public static create(properties?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.ILinkPreviewHighQualityThumbnail): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.LinkPreviewHighQualityThumbnail;
            public static encode(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.ILinkPreviewHighQualityThumbnail, w?: Writer): Writer;
            public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.LinkPreviewHighQualityThumbnail;
            public static fromObject(d: {
              [k: string]: any;
            }): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.LinkPreviewHighQualityThumbnail;
            public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.LinkPreviewHighQualityThumbnail, o?: IConversionOptions): {
              [k: string]: any;
            };
            public toJSON(): {
              [k: string]: any;
            };
            public static getTypeUrl(typeUrlPrefix?: string): string;
          }
          interface IPaymentLinkPreviewMetadata {
            isBusinessVerified?: (boolean | null);
            providerName?: (string | null);
          }
          class PaymentLinkPreviewMetadata implements IPaymentLinkPreviewMetadata {
            constructor(p?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.IPaymentLinkPreviewMetadata);
            public isBusinessVerified?: (boolean | null);
            public providerName?: (string | null);
            public static create(properties?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.IPaymentLinkPreviewMetadata): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.PaymentLinkPreviewMetadata;
            public static encode(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.IPaymentLinkPreviewMetadata, w?: Writer): Writer;
            public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.PaymentLinkPreviewMetadata;
            public static fromObject(d: {
              [k: string]: any;
            }): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.PaymentLinkPreviewMetadata;
            public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.LinkPreviewResponse.PaymentLinkPreviewMetadata, o?: IConversionOptions): {
              [k: string]: any;
            };
            public toJSON(): {
              [k: string]: any;
            };
            public static getTypeUrl(typeUrlPrefix?: string): string;
          }
        }
        interface IPlaceholderMessageResendResponse {
          webMessageInfoBytes?: (Uint8Array | null);
        }
        class PlaceholderMessageResendResponse implements IPlaceholderMessageResendResponse {
          constructor(p?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IPlaceholderMessageResendResponse);
          public webMessageInfoBytes?: (Uint8Array | null);
          public static create(properties?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IPlaceholderMessageResendResponse): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.PlaceholderMessageResendResponse;
          public static encode(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IPlaceholderMessageResendResponse, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.PlaceholderMessageResendResponse;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.PlaceholderMessageResendResponse;
          public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.PlaceholderMessageResendResponse, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        interface ISyncDSnapshotFatalRecoveryResponse {
          collectionSnapshot?: (Uint8Array | null);
          isCompressed?: (boolean | null);
        }
        class SyncDSnapshotFatalRecoveryResponse implements ISyncDSnapshotFatalRecoveryResponse {
          constructor(p?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ISyncDSnapshotFatalRecoveryResponse);
          public collectionSnapshot?: (Uint8Array | null);
          public isCompressed?: (boolean | null);
          public static create(properties?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ISyncDSnapshotFatalRecoveryResponse): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.SyncDSnapshotFatalRecoveryResponse;
          public static encode(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.ISyncDSnapshotFatalRecoveryResponse, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.SyncDSnapshotFatalRecoveryResponse;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.SyncDSnapshotFatalRecoveryResponse;
          public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.SyncDSnapshotFatalRecoveryResponse, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
        interface IWaffleNonceFetchResponse {
          nonce?: (string | null);
          waEntFbid?: (string | null);
        }
        class WaffleNonceFetchResponse implements IWaffleNonceFetchResponse {
          constructor(p?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IWaffleNonceFetchResponse);
          public nonce?: (string | null);
          public waEntFbid?: (string | null);
          public static create(properties?: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IWaffleNonceFetchResponse): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.WaffleNonceFetchResponse;
          public static encode(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.IWaffleNonceFetchResponse, w?: Writer): Writer;
          public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.WaffleNonceFetchResponse;
          public static fromObject(d: {
            [k: string]: any;
          }): proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.WaffleNonceFetchResponse;
          public static toObject(m: proto.Message.PeerDataOperationRequestResponseMessage.PeerDataOperationResult.WaffleNonceFetchResponse, o?: IConversionOptions): {
            [k: string]: any;
          };
          public toJSON(): {
            [k: string]: any;
          };
          public static getTypeUrl(typeUrlPrefix?: string): string;
        }
      }
    }
    enum PeerDataOperationRequestType {
      UPLOAD_STICKER = 0,
      SEND_RECENT_STICKER_BOOTSTRAP = 1,
      GENERATE_LINK_PREVIEW = 2,
      HISTORY_SYNC_ON_DEMAND = 3,
      PLACEHOLDER_MESSAGE_RESEND = 4,
      WAFFLE_LINKING_NONCE_FETCH = 5,
      FULL_HISTORY_SYNC_ON_DEMAND = 6,
      COMPANION_META_NONCE_FETCH = 7,
      COMPANION_SYNCD_SNAPSHOT_FATAL_RECOVERY = 8,
      COMPANION_CANONICAL_USER_NONCE_FETCH = 9,
      HISTORY_SYNC_CHUNK_RETRY = 10,
      GALAXY_FLOW_ACTION = 11
    }
    interface IPinInChatMessage {
      key?: (proto.IMessageKey | null);
      type?: (proto.Message.PinInChatMessage.Type | null);
      senderTimestampMs?: (number | Long$1 | null);
    }
    class PinInChatMessage implements IPinInChatMessage {
      constructor(p?: proto.Message.IPinInChatMessage);
      public key?: (proto.IMessageKey | null);
      public type?: (proto.Message.PinInChatMessage.Type | null);
      public senderTimestampMs?: (number | Long$1 | null);
      public static create(properties?: proto.Message.IPinInChatMessage): proto.Message.PinInChatMessage;
      public static encode(m: proto.Message.IPinInChatMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PinInChatMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PinInChatMessage;
      public static toObject(m: proto.Message.PinInChatMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace PinInChatMessage {
      enum Type {
        UNKNOWN_TYPE = 0,
        PIN_FOR_ALL = 1,
        UNPIN_FOR_ALL = 2
      }
    }
    interface IPlaceholderMessage {
      type?: (proto.Message.PlaceholderMessage.PlaceholderType | null);
    }
    class PlaceholderMessage implements IPlaceholderMessage {
      constructor(p?: proto.Message.IPlaceholderMessage);
      public type?: (proto.Message.PlaceholderMessage.PlaceholderType | null);
      public static create(properties?: proto.Message.IPlaceholderMessage): proto.Message.PlaceholderMessage;
      public static encode(m: proto.Message.IPlaceholderMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PlaceholderMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PlaceholderMessage;
      public static toObject(m: proto.Message.PlaceholderMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace PlaceholderMessage {
      enum PlaceholderType {
        MASK_LINKED_DEVICES = 0
      }
    }
    enum PollContentType {
      UNKNOWN = 0,
      TEXT = 1,
      IMAGE = 2
    }
    interface IPollCreationMessage {
      encKey?: (Uint8Array | null);
      name?: (string | null);
      options?: (proto.Message.PollCreationMessage.IOption[] | null);
      selectableOptionsCount?: (number | null);
      contextInfo?: (proto.IContextInfo | null);
      pollContentType?: (proto.Message.PollContentType | null);
      pollType?: (proto.Message.PollType | null);
      correctAnswer?: (proto.Message.PollCreationMessage.IOption | null);
    }
    class PollCreationMessage implements IPollCreationMessage {
      constructor(p?: proto.Message.IPollCreationMessage);
      public encKey?: (Uint8Array | null);
      public name?: (string | null);
      public options: proto.Message.PollCreationMessage.IOption[];
      public selectableOptionsCount?: (number | null);
      public contextInfo?: (proto.IContextInfo | null);
      public pollContentType?: (proto.Message.PollContentType | null);
      public pollType?: (proto.Message.PollType | null);
      public correctAnswer?: (proto.Message.PollCreationMessage.IOption | null);
      public static create(properties?: proto.Message.IPollCreationMessage): proto.Message.PollCreationMessage;
      public static encode(m: proto.Message.IPollCreationMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PollCreationMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PollCreationMessage;
      public static toObject(m: proto.Message.PollCreationMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace PollCreationMessage {
      interface IOption {
        optionName?: (string | null);
        optionHash?: (string | null);
      }
      class Option implements IOption {
        constructor(p?: proto.Message.PollCreationMessage.IOption);
        public optionName?: (string | null);
        public optionHash?: (string | null);
        public static create(properties?: proto.Message.PollCreationMessage.IOption): proto.Message.PollCreationMessage.Option;
        public static encode(m: proto.Message.PollCreationMessage.IOption, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PollCreationMessage.Option;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PollCreationMessage.Option;
        public static toObject(m: proto.Message.PollCreationMessage.Option, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface IPollEncValue {
      encPayload?: (Uint8Array | null);
      encIv?: (Uint8Array | null);
    }
    class PollEncValue implements IPollEncValue {
      constructor(p?: proto.Message.IPollEncValue);
      public encPayload?: (Uint8Array | null);
      public encIv?: (Uint8Array | null);
      public static create(properties?: proto.Message.IPollEncValue): proto.Message.PollEncValue;
      public static encode(m: proto.Message.IPollEncValue, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PollEncValue;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PollEncValue;
      public static toObject(m: proto.Message.PollEncValue, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPollResultSnapshotMessage {
      name?: (string | null);
      pollVotes?: (proto.Message.PollResultSnapshotMessage.IPollVote[] | null);
      contextInfo?: (proto.IContextInfo | null);
      pollType?: (proto.Message.PollType | null);
    }
    class PollResultSnapshotMessage implements IPollResultSnapshotMessage {
      constructor(p?: proto.Message.IPollResultSnapshotMessage);
      public name?: (string | null);
      public pollVotes: proto.Message.PollResultSnapshotMessage.IPollVote[];
      public contextInfo?: (proto.IContextInfo | null);
      public pollType?: (proto.Message.PollType | null);
      public static create(properties?: proto.Message.IPollResultSnapshotMessage): proto.Message.PollResultSnapshotMessage;
      public static encode(m: proto.Message.IPollResultSnapshotMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PollResultSnapshotMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PollResultSnapshotMessage;
      public static toObject(m: proto.Message.PollResultSnapshotMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace PollResultSnapshotMessage {
      interface IPollVote {
        optionName?: (string | null);
        optionVoteCount?: (number | Long$1 | null);
      }
      class PollVote implements IPollVote {
        constructor(p?: proto.Message.PollResultSnapshotMessage.IPollVote);
        public optionName?: (string | null);
        public optionVoteCount?: (number | Long$1 | null);
        public static create(properties?: proto.Message.PollResultSnapshotMessage.IPollVote): proto.Message.PollResultSnapshotMessage.PollVote;
        public static encode(m: proto.Message.PollResultSnapshotMessage.IPollVote, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PollResultSnapshotMessage.PollVote;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.PollResultSnapshotMessage.PollVote;
        public static toObject(m: proto.Message.PollResultSnapshotMessage.PollVote, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    enum PollType {
      POLL = 0,
      QUIZ = 1
    }
    interface IPollUpdateMessage {
      pollCreationMessageKey?: (proto.IMessageKey | null);
      vote?: (proto.Message.IPollEncValue | null);
      metadata?: (proto.Message.IPollUpdateMessageMetadata | null);
      senderTimestampMs?: (number | Long$1 | null);
    }
    class PollUpdateMessage implements IPollUpdateMessage {
      constructor(p?: proto.Message.IPollUpdateMessage);
      public pollCreationMessageKey?: (proto.IMessageKey | null);
      public vote?: (proto.Message.IPollEncValue | null);
      public metadata?: (proto.Message.IPollUpdateMessageMetadata | null);
      public senderTimestampMs?: (number | Long$1 | null);
      public static create(properties?: proto.Message.IPollUpdateMessage): proto.Message.PollUpdateMessage;
      public static encode(m: proto.Message.IPollUpdateMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PollUpdateMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PollUpdateMessage;
      public static toObject(m: proto.Message.PollUpdateMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPollUpdateMessageMetadata {}
    class PollUpdateMessageMetadata implements IPollUpdateMessageMetadata {
      constructor(p?: proto.Message.IPollUpdateMessageMetadata);
      public static create(properties?: proto.Message.IPollUpdateMessageMetadata): proto.Message.PollUpdateMessageMetadata;
      public static encode(m: proto.Message.IPollUpdateMessageMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PollUpdateMessageMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PollUpdateMessageMetadata;
      public static toObject(m: proto.Message.PollUpdateMessageMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPollVoteMessage {
      selectedOptions?: (Uint8Array[] | null);
    }
    class PollVoteMessage implements IPollVoteMessage {
      constructor(p?: proto.Message.IPollVoteMessage);
      public selectedOptions: Uint8Array[];
      public static create(properties?: proto.Message.IPollVoteMessage): proto.Message.PollVoteMessage;
      public static encode(m: proto.Message.IPollVoteMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.PollVoteMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.PollVoteMessage;
      public static toObject(m: proto.Message.PollVoteMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IProductMessage {
      product?: (proto.Message.ProductMessage.IProductSnapshot | null);
      businessOwnerJid?: (string | null);
      catalog?: (proto.Message.ProductMessage.ICatalogSnapshot | null);
      body?: (string | null);
      footer?: (string | null);
      contextInfo?: (proto.IContextInfo | null);
    }
    class ProductMessage implements IProductMessage {
      constructor(p?: proto.Message.IProductMessage);
      public product?: (proto.Message.ProductMessage.IProductSnapshot | null);
      public businessOwnerJid?: (string | null);
      public catalog?: (proto.Message.ProductMessage.ICatalogSnapshot | null);
      public body?: (string | null);
      public footer?: (string | null);
      public contextInfo?: (proto.IContextInfo | null);
      public static create(properties?: proto.Message.IProductMessage): proto.Message.ProductMessage;
      public static encode(m: proto.Message.IProductMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ProductMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ProductMessage;
      public static toObject(m: proto.Message.ProductMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ProductMessage {
      interface ICatalogSnapshot {
        catalogImage?: (proto.Message.IImageMessage | null);
        title?: (string | null);
        description?: (string | null);
      }
      class CatalogSnapshot implements ICatalogSnapshot {
        constructor(p?: proto.Message.ProductMessage.ICatalogSnapshot);
        public catalogImage?: (proto.Message.IImageMessage | null);
        public title?: (string | null);
        public description?: (string | null);
        public static create(properties?: proto.Message.ProductMessage.ICatalogSnapshot): proto.Message.ProductMessage.CatalogSnapshot;
        public static encode(m: proto.Message.ProductMessage.ICatalogSnapshot, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ProductMessage.CatalogSnapshot;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.ProductMessage.CatalogSnapshot;
        public static toObject(m: proto.Message.ProductMessage.CatalogSnapshot, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IProductSnapshot {
        productImage?: (proto.Message.IImageMessage | null);
        productId?: (string | null);
        title?: (string | null);
        description?: (string | null);
        currencyCode?: (string | null);
        priceAmount1000?: (number | Long$1 | null);
        retailerId?: (string | null);
        url?: (string | null);
        productImageCount?: (number | null);
        firstImageId?: (string | null);
        salePriceAmount1000?: (number | Long$1 | null);
        signedUrl?: (string | null);
      }
      class ProductSnapshot implements IProductSnapshot {
        constructor(p?: proto.Message.ProductMessage.IProductSnapshot);
        public productImage?: (proto.Message.IImageMessage | null);
        public productId?: (string | null);
        public title?: (string | null);
        public description?: (string | null);
        public currencyCode?: (string | null);
        public priceAmount1000?: (number | Long$1 | null);
        public retailerId?: (string | null);
        public url?: (string | null);
        public productImageCount?: (number | null);
        public firstImageId?: (string | null);
        public salePriceAmount1000?: (number | Long$1 | null);
        public signedUrl?: (string | null);
        public static create(properties?: proto.Message.ProductMessage.IProductSnapshot): proto.Message.ProductMessage.ProductSnapshot;
        public static encode(m: proto.Message.ProductMessage.IProductSnapshot, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ProductMessage.ProductSnapshot;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.ProductMessage.ProductSnapshot;
        public static toObject(m: proto.Message.ProductMessage.ProductSnapshot, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface IProtocolMessage {
      key?: (proto.IMessageKey | null);
      type?: (proto.Message.ProtocolMessage.Type | null);
      ephemeralExpiration?: (number | null);
      ephemeralSettingTimestamp?: (number | Long$1 | null);
      historySyncNotification?: (proto.Message.IHistorySyncNotification | null);
      appStateSyncKeyShare?: (proto.Message.IAppStateSyncKeyShare | null);
      appStateSyncKeyRequest?: (proto.Message.IAppStateSyncKeyRequest | null);
      initialSecurityNotificationSettingSync?: (proto.Message.IInitialSecurityNotificationSettingSync | null);
      appStateFatalExceptionNotification?: (proto.Message.IAppStateFatalExceptionNotification | null);
      disappearingMode?: (proto.IDisappearingMode | null);
      editedMessage?: (proto.IMessage | null);
      timestampMs?: (number | Long$1 | null);
      peerDataOperationRequestMessage?: (proto.Message.IPeerDataOperationRequestMessage | null);
      peerDataOperationRequestResponseMessage?: (proto.Message.IPeerDataOperationRequestResponseMessage | null);
      botFeedbackMessage?: (proto.IBotFeedbackMessage | null);
      invokerJid?: (string | null);
      requestWelcomeMessageMetadata?: (proto.Message.IRequestWelcomeMessageMetadata | null);
      mediaNotifyMessage?: (proto.IMediaNotifyMessage | null);
      cloudApiThreadControlNotification?: (proto.Message.ICloudAPIThreadControlNotification | null);
      lidMigrationMappingSyncMessage?: (proto.ILIDMigrationMappingSyncMessage | null);
      limitSharing?: (proto.ILimitSharing | null);
      aiPsiMetadata?: (Uint8Array | null);
      aiQueryFanout?: (proto.IAIQueryFanout | null);
      memberLabel?: (proto.IMemberLabel | null);
    }
    class ProtocolMessage implements IProtocolMessage {
      constructor(p?: proto.Message.IProtocolMessage);
      public key?: (proto.IMessageKey | null);
      public type?: (proto.Message.ProtocolMessage.Type | null);
      public ephemeralExpiration?: (number | null);
      public ephemeralSettingTimestamp?: (number | Long$1 | null);
      public historySyncNotification?: (proto.Message.IHistorySyncNotification | null);
      public appStateSyncKeyShare?: (proto.Message.IAppStateSyncKeyShare | null);
      public appStateSyncKeyRequest?: (proto.Message.IAppStateSyncKeyRequest | null);
      public initialSecurityNotificationSettingSync?: (proto.Message.IInitialSecurityNotificationSettingSync | null);
      public appStateFatalExceptionNotification?: (proto.Message.IAppStateFatalExceptionNotification | null);
      public disappearingMode?: (proto.IDisappearingMode | null);
      public editedMessage?: (proto.IMessage | null);
      public timestampMs?: (number | Long$1 | null);
      public peerDataOperationRequestMessage?: (proto.Message.IPeerDataOperationRequestMessage | null);
      public peerDataOperationRequestResponseMessage?: (proto.Message.IPeerDataOperationRequestResponseMessage | null);
      public botFeedbackMessage?: (proto.IBotFeedbackMessage | null);
      public invokerJid?: (string | null);
      public requestWelcomeMessageMetadata?: (proto.Message.IRequestWelcomeMessageMetadata | null);
      public mediaNotifyMessage?: (proto.IMediaNotifyMessage | null);
      public cloudApiThreadControlNotification?: (proto.Message.ICloudAPIThreadControlNotification | null);
      public lidMigrationMappingSyncMessage?: (proto.ILIDMigrationMappingSyncMessage | null);
      public limitSharing?: (proto.ILimitSharing | null);
      public aiPsiMetadata?: (Uint8Array | null);
      public aiQueryFanout?: (proto.IAIQueryFanout | null);
      public memberLabel?: (proto.IMemberLabel | null);
      public static create(properties?: proto.Message.IProtocolMessage): proto.Message.ProtocolMessage;
      public static encode(m: proto.Message.IProtocolMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ProtocolMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ProtocolMessage;
      public static toObject(m: proto.Message.ProtocolMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ProtocolMessage {
      enum Type {
        REVOKE = 0,
        EPHEMERAL_SETTING = 3,
        EPHEMERAL_SYNC_RESPONSE = 4,
        HISTORY_SYNC_NOTIFICATION = 5,
        APP_STATE_SYNC_KEY_SHARE = 6,
        APP_STATE_SYNC_KEY_REQUEST = 7,
        MSG_FANOUT_BACKFILL_REQUEST = 8,
        INITIAL_SECURITY_NOTIFICATION_SETTING_SYNC = 9,
        APP_STATE_FATAL_EXCEPTION_NOTIFICATION = 10,
        SHARE_PHONE_NUMBER = 11,
        MESSAGE_EDIT = 14,
        PEER_DATA_OPERATION_REQUEST_MESSAGE = 16,
        PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE = 17,
        REQUEST_WELCOME_MESSAGE = 18,
        BOT_FEEDBACK_MESSAGE = 19,
        MEDIA_NOTIFY_MESSAGE = 20,
        CLOUD_API_THREAD_CONTROL_NOTIFICATION = 21,
        LID_MIGRATION_MAPPING_SYNC = 22,
        REMINDER_MESSAGE = 23,
        BOT_MEMU_ONBOARDING_MESSAGE = 24,
        STATUS_MENTION_MESSAGE = 25,
        STOP_GENERATION_MESSAGE = 26,
        LIMIT_SHARING = 27,
        AI_PSI_METADATA = 28,
        AI_QUERY_FANOUT = 29,
        GROUP_MEMBER_LABEL_CHANGE = 30
      }
    }
    interface IQuestionResponseMessage {
      key?: (proto.IMessageKey | null);
      text?: (string | null);
    }
    class QuestionResponseMessage implements IQuestionResponseMessage {
      constructor(p?: proto.Message.IQuestionResponseMessage);
      public key?: (proto.IMessageKey | null);
      public text?: (string | null);
      public static create(properties?: proto.Message.IQuestionResponseMessage): proto.Message.QuestionResponseMessage;
      public static encode(m: proto.Message.IQuestionResponseMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.QuestionResponseMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.QuestionResponseMessage;
      public static toObject(m: proto.Message.QuestionResponseMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IReactionMessage {
      key?: (proto.IMessageKey | null);
      text?: (string | null);
      groupingKey?: (string | null);
      senderTimestampMs?: (number | Long$1 | null);
    }
    class ReactionMessage implements IReactionMessage {
      constructor(p?: proto.Message.IReactionMessage);
      public key?: (proto.IMessageKey | null);
      public text?: (string | null);
      public groupingKey?: (string | null);
      public senderTimestampMs?: (number | Long$1 | null);
      public static create(properties?: proto.Message.IReactionMessage): proto.Message.ReactionMessage;
      public static encode(m: proto.Message.IReactionMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ReactionMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ReactionMessage;
      public static toObject(m: proto.Message.ReactionMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IRequestPaymentMessage {
      noteMessage?: (proto.IMessage | null);
      currencyCodeIso4217?: (string | null);
      amount1000?: (number | Long$1 | null);
      requestFrom?: (string | null);
      expiryTimestamp?: (number | Long$1 | null);
      amount?: (proto.IMoney | null);
      background?: (proto.IPaymentBackground | null);
    }
    class RequestPaymentMessage implements IRequestPaymentMessage {
      constructor(p?: proto.Message.IRequestPaymentMessage);
      public noteMessage?: (proto.IMessage | null);
      public currencyCodeIso4217?: (string | null);
      public amount1000?: (number | Long$1 | null);
      public requestFrom?: (string | null);
      public expiryTimestamp?: (number | Long$1 | null);
      public amount?: (proto.IMoney | null);
      public background?: (proto.IPaymentBackground | null);
      public static create(properties?: proto.Message.IRequestPaymentMessage): proto.Message.RequestPaymentMessage;
      public static encode(m: proto.Message.IRequestPaymentMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.RequestPaymentMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.RequestPaymentMessage;
      public static toObject(m: proto.Message.RequestPaymentMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IRequestPhoneNumberMessage {
      contextInfo?: (proto.IContextInfo | null);
    }
    class RequestPhoneNumberMessage implements IRequestPhoneNumberMessage {
      constructor(p?: proto.Message.IRequestPhoneNumberMessage);
      public contextInfo?: (proto.IContextInfo | null);
      public static create(properties?: proto.Message.IRequestPhoneNumberMessage): proto.Message.RequestPhoneNumberMessage;
      public static encode(m: proto.Message.IRequestPhoneNumberMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.RequestPhoneNumberMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.RequestPhoneNumberMessage;
      public static toObject(m: proto.Message.RequestPhoneNumberMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IRequestWelcomeMessageMetadata {
      localChatState?: (proto.Message.RequestWelcomeMessageMetadata.LocalChatState | null);
    }
    class RequestWelcomeMessageMetadata implements IRequestWelcomeMessageMetadata {
      constructor(p?: proto.Message.IRequestWelcomeMessageMetadata);
      public localChatState?: (proto.Message.RequestWelcomeMessageMetadata.LocalChatState | null);
      public static create(properties?: proto.Message.IRequestWelcomeMessageMetadata): proto.Message.RequestWelcomeMessageMetadata;
      public static encode(m: proto.Message.IRequestWelcomeMessageMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.RequestWelcomeMessageMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.RequestWelcomeMessageMetadata;
      public static toObject(m: proto.Message.RequestWelcomeMessageMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace RequestWelcomeMessageMetadata {
      enum LocalChatState {
        EMPTY = 0,
        NON_EMPTY = 1
      }
    }
    interface IScheduledCallCreationMessage {
      scheduledTimestampMs?: (number | Long$1 | null);
      callType?: (proto.Message.ScheduledCallCreationMessage.CallType | null);
      title?: (string | null);
    }
    class ScheduledCallCreationMessage implements IScheduledCallCreationMessage {
      constructor(p?: proto.Message.IScheduledCallCreationMessage);
      public scheduledTimestampMs?: (number | Long$1 | null);
      public callType?: (proto.Message.ScheduledCallCreationMessage.CallType | null);
      public title?: (string | null);
      public static create(properties?: proto.Message.IScheduledCallCreationMessage): proto.Message.ScheduledCallCreationMessage;
      public static encode(m: proto.Message.IScheduledCallCreationMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ScheduledCallCreationMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ScheduledCallCreationMessage;
      public static toObject(m: proto.Message.ScheduledCallCreationMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ScheduledCallCreationMessage {
      enum CallType {
        UNKNOWN = 0,
        VOICE = 1,
        VIDEO = 2
      }
    }
    interface IScheduledCallEditMessage {
      key?: (proto.IMessageKey | null);
      editType?: (proto.Message.ScheduledCallEditMessage.EditType | null);
    }
    class ScheduledCallEditMessage implements IScheduledCallEditMessage {
      constructor(p?: proto.Message.IScheduledCallEditMessage);
      public key?: (proto.IMessageKey | null);
      public editType?: (proto.Message.ScheduledCallEditMessage.EditType | null);
      public static create(properties?: proto.Message.IScheduledCallEditMessage): proto.Message.ScheduledCallEditMessage;
      public static encode(m: proto.Message.IScheduledCallEditMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.ScheduledCallEditMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.ScheduledCallEditMessage;
      public static toObject(m: proto.Message.ScheduledCallEditMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ScheduledCallEditMessage {
      enum EditType {
        UNKNOWN = 0,
        CANCEL = 1
      }
    }
    interface ISecretEncryptedMessage {
      targetMessageKey?: (proto.IMessageKey | null);
      encPayload?: (Uint8Array | null);
      encIv?: (Uint8Array | null);
      secretEncType?: (proto.Message.SecretEncryptedMessage.SecretEncType | null);
    }
    class SecretEncryptedMessage implements ISecretEncryptedMessage {
      constructor(p?: proto.Message.ISecretEncryptedMessage);
      public targetMessageKey?: (proto.IMessageKey | null);
      public encPayload?: (Uint8Array | null);
      public encIv?: (Uint8Array | null);
      public secretEncType?: (proto.Message.SecretEncryptedMessage.SecretEncType | null);
      public static create(properties?: proto.Message.ISecretEncryptedMessage): proto.Message.SecretEncryptedMessage;
      public static encode(m: proto.Message.ISecretEncryptedMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.SecretEncryptedMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.SecretEncryptedMessage;
      public static toObject(m: proto.Message.SecretEncryptedMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace SecretEncryptedMessage {
      enum SecretEncType {
        UNKNOWN = 0,
        EVENT_EDIT = 1,
        MESSAGE_EDIT = 2
      }
    }
    interface ISendPaymentMessage {
      noteMessage?: (proto.IMessage | null);
      requestMessageKey?: (proto.IMessageKey | null);
      background?: (proto.IPaymentBackground | null);
      transactionData?: (string | null);
    }
    class SendPaymentMessage implements ISendPaymentMessage {
      constructor(p?: proto.Message.ISendPaymentMessage);
      public noteMessage?: (proto.IMessage | null);
      public requestMessageKey?: (proto.IMessageKey | null);
      public background?: (proto.IPaymentBackground | null);
      public transactionData?: (string | null);
      public static create(properties?: proto.Message.ISendPaymentMessage): proto.Message.SendPaymentMessage;
      public static encode(m: proto.Message.ISendPaymentMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.SendPaymentMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.SendPaymentMessage;
      public static toObject(m: proto.Message.SendPaymentMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ISenderKeyDistributionMessage {
      groupId?: (string | null);
      axolotlSenderKeyDistributionMessage?: (Uint8Array | null);
    }
    class SenderKeyDistributionMessage implements ISenderKeyDistributionMessage {
      constructor(p?: proto.Message.ISenderKeyDistributionMessage);
      public groupId?: (string | null);
      public axolotlSenderKeyDistributionMessage?: (Uint8Array | null);
      public static create(properties?: proto.Message.ISenderKeyDistributionMessage): proto.Message.SenderKeyDistributionMessage;
      public static encode(m: proto.Message.ISenderKeyDistributionMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.SenderKeyDistributionMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.SenderKeyDistributionMessage;
      public static toObject(m: proto.Message.SenderKeyDistributionMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IStatusNotificationMessage {
      responseMessageKey?: (proto.IMessageKey | null);
      originalMessageKey?: (proto.IMessageKey | null);
      type?: (proto.Message.StatusNotificationMessage.StatusNotificationType | null);
    }
    class StatusNotificationMessage implements IStatusNotificationMessage {
      constructor(p?: proto.Message.IStatusNotificationMessage);
      public responseMessageKey?: (proto.IMessageKey | null);
      public originalMessageKey?: (proto.IMessageKey | null);
      public type?: (proto.Message.StatusNotificationMessage.StatusNotificationType | null);
      public static create(properties?: proto.Message.IStatusNotificationMessage): proto.Message.StatusNotificationMessage;
      public static encode(m: proto.Message.IStatusNotificationMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.StatusNotificationMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.StatusNotificationMessage;
      public static toObject(m: proto.Message.StatusNotificationMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace StatusNotificationMessage {
      enum StatusNotificationType {
        UNKNOWN = 0,
        STATUS_ADD_YOURS = 1,
        STATUS_RESHARE = 2,
        STATUS_QUESTION_ANSWER_RESHARE = 3
      }
    }
    interface IStatusQuestionAnswerMessage {
      key?: (proto.IMessageKey | null);
      text?: (string | null);
    }
    class StatusQuestionAnswerMessage implements IStatusQuestionAnswerMessage {
      constructor(p?: proto.Message.IStatusQuestionAnswerMessage);
      public key?: (proto.IMessageKey | null);
      public text?: (string | null);
      public static create(properties?: proto.Message.IStatusQuestionAnswerMessage): proto.Message.StatusQuestionAnswerMessage;
      public static encode(m: proto.Message.IStatusQuestionAnswerMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.StatusQuestionAnswerMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.StatusQuestionAnswerMessage;
      public static toObject(m: proto.Message.StatusQuestionAnswerMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IStatusQuotedMessage {
      type?: (proto.Message.StatusQuotedMessage.StatusQuotedMessageType | null);
      text?: (string | null);
      thumbnail?: (Uint8Array | null);
      originalStatusId?: (proto.IMessageKey | null);
    }
    class StatusQuotedMessage implements IStatusQuotedMessage {
      constructor(p?: proto.Message.IStatusQuotedMessage);
      public type?: (proto.Message.StatusQuotedMessage.StatusQuotedMessageType | null);
      public text?: (string | null);
      public thumbnail?: (Uint8Array | null);
      public originalStatusId?: (proto.IMessageKey | null);
      public static create(properties?: proto.Message.IStatusQuotedMessage): proto.Message.StatusQuotedMessage;
      public static encode(m: proto.Message.IStatusQuotedMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.StatusQuotedMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.StatusQuotedMessage;
      public static toObject(m: proto.Message.StatusQuotedMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace StatusQuotedMessage {
      enum StatusQuotedMessageType {
        QUESTION_ANSWER = 1
      }
    }
    interface IStatusStickerInteractionMessage {
      key?: (proto.IMessageKey | null);
      stickerKey?: (string | null);
      type?: (proto.Message.StatusStickerInteractionMessage.StatusStickerType | null);
    }
    class StatusStickerInteractionMessage implements IStatusStickerInteractionMessage {
      constructor(p?: proto.Message.IStatusStickerInteractionMessage);
      public key?: (proto.IMessageKey | null);
      public stickerKey?: (string | null);
      public type?: (proto.Message.StatusStickerInteractionMessage.StatusStickerType | null);
      public static create(properties?: proto.Message.IStatusStickerInteractionMessage): proto.Message.StatusStickerInteractionMessage;
      public static encode(m: proto.Message.IStatusStickerInteractionMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.StatusStickerInteractionMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.StatusStickerInteractionMessage;
      public static toObject(m: proto.Message.StatusStickerInteractionMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace StatusStickerInteractionMessage {
      enum StatusStickerType {
        UNKNOWN = 0,
        REACTION = 1
      }
    }
    interface IStickerMessage {
      url?: (string | null);
      fileSha256?: (Uint8Array | null);
      fileEncSha256?: (Uint8Array | null);
      mediaKey?: (Uint8Array | null);
      mimetype?: (string | null);
      height?: (number | null);
      width?: (number | null);
      directPath?: (string | null);
      fileLength?: (number | Long$1 | null);
      mediaKeyTimestamp?: (number | Long$1 | null);
      firstFrameLength?: (number | null);
      firstFrameSidecar?: (Uint8Array | null);
      isAnimated?: (boolean | null);
      pngThumbnail?: (Uint8Array | null);
      contextInfo?: (proto.IContextInfo | null);
      stickerSentTs?: (number | Long$1 | null);
      isAvatar?: (boolean | null);
      isAiSticker?: (boolean | null);
      isLottie?: (boolean | null);
      accessibilityLabel?: (string | null);
      mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
    }
    class StickerMessage implements IStickerMessage {
      constructor(p?: proto.Message.IStickerMessage);
      public url?: (string | null);
      public fileSha256?: (Uint8Array | null);
      public fileEncSha256?: (Uint8Array | null);
      public mediaKey?: (Uint8Array | null);
      public mimetype?: (string | null);
      public height?: (number | null);
      public width?: (number | null);
      public directPath?: (string | null);
      public fileLength?: (number | Long$1 | null);
      public mediaKeyTimestamp?: (number | Long$1 | null);
      public firstFrameLength?: (number | null);
      public firstFrameSidecar?: (Uint8Array | null);
      public isAnimated?: (boolean | null);
      public pngThumbnail?: (Uint8Array | null);
      public contextInfo?: (proto.IContextInfo | null);
      public stickerSentTs?: (number | Long$1 | null);
      public isAvatar?: (boolean | null);
      public isAiSticker?: (boolean | null);
      public isLottie?: (boolean | null);
      public accessibilityLabel?: (string | null);
      public mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
      public static create(properties?: proto.Message.IStickerMessage): proto.Message.StickerMessage;
      public static encode(m: proto.Message.IStickerMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.StickerMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.StickerMessage;
      public static toObject(m: proto.Message.StickerMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IStickerPackMessage {
      stickerPackId?: (string | null);
      name?: (string | null);
      publisher?: (string | null);
      stickers?: (proto.Message.StickerPackMessage.ISticker[] | null);
      fileLength?: (number | Long$1 | null);
      fileSha256?: (Uint8Array | null);
      fileEncSha256?: (Uint8Array | null);
      mediaKey?: (Uint8Array | null);
      directPath?: (string | null);
      caption?: (string | null);
      contextInfo?: (proto.IContextInfo | null);
      packDescription?: (string | null);
      mediaKeyTimestamp?: (number | Long$1 | null);
      trayIconFileName?: (string | null);
      thumbnailDirectPath?: (string | null);
      thumbnailSha256?: (Uint8Array | null);
      thumbnailEncSha256?: (Uint8Array | null);
      thumbnailHeight?: (number | null);
      thumbnailWidth?: (number | null);
      imageDataHash?: (string | null);
      stickerPackSize?: (number | Long$1 | null);
      stickerPackOrigin?: (proto.Message.StickerPackMessage.StickerPackOrigin | null);
    }
    class StickerPackMessage implements IStickerPackMessage {
      constructor(p?: proto.Message.IStickerPackMessage);
      public stickerPackId?: (string | null);
      public name?: (string | null);
      public publisher?: (string | null);
      public stickers: proto.Message.StickerPackMessage.ISticker[];
      public fileLength?: (number | Long$1 | null);
      public fileSha256?: (Uint8Array | null);
      public fileEncSha256?: (Uint8Array | null);
      public mediaKey?: (Uint8Array | null);
      public directPath?: (string | null);
      public caption?: (string | null);
      public contextInfo?: (proto.IContextInfo | null);
      public packDescription?: (string | null);
      public mediaKeyTimestamp?: (number | Long$1 | null);
      public trayIconFileName?: (string | null);
      public thumbnailDirectPath?: (string | null);
      public thumbnailSha256?: (Uint8Array | null);
      public thumbnailEncSha256?: (Uint8Array | null);
      public thumbnailHeight?: (number | null);
      public thumbnailWidth?: (number | null);
      public imageDataHash?: (string | null);
      public stickerPackSize?: (number | Long$1 | null);
      public stickerPackOrigin?: (proto.Message.StickerPackMessage.StickerPackOrigin | null);
      public static create(properties?: proto.Message.IStickerPackMessage): proto.Message.StickerPackMessage;
      public static encode(m: proto.Message.IStickerPackMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.StickerPackMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.StickerPackMessage;
      public static toObject(m: proto.Message.StickerPackMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace StickerPackMessage {
      interface ISticker {
        fileName?: (string | null);
        isAnimated?: (boolean | null);
        emojis?: (string[] | null);
        accessibilityLabel?: (string | null);
        isLottie?: (boolean | null);
        mimetype?: (string | null);
      }
      class Sticker implements ISticker {
        constructor(p?: proto.Message.StickerPackMessage.ISticker);
        public fileName?: (string | null);
        public isAnimated?: (boolean | null);
        public emojis: string[];
        public accessibilityLabel?: (string | null);
        public isLottie?: (boolean | null);
        public mimetype?: (string | null);
        public static create(properties?: proto.Message.StickerPackMessage.ISticker): proto.Message.StickerPackMessage.Sticker;
        public static encode(m: proto.Message.StickerPackMessage.ISticker, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.StickerPackMessage.Sticker;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.StickerPackMessage.Sticker;
        public static toObject(m: proto.Message.StickerPackMessage.Sticker, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      enum StickerPackOrigin {
        FIRST_PARTY = 0,
        THIRD_PARTY = 1,
        USER_CREATED = 2
      }
    }
    interface IStickerSyncRMRMessage {
      filehash?: (string[] | null);
      rmrSource?: (string | null);
      requestTimestamp?: (number | Long$1 | null);
    }
    class StickerSyncRMRMessage implements IStickerSyncRMRMessage {
      constructor(p?: proto.Message.IStickerSyncRMRMessage);
      public filehash: string[];
      public rmrSource?: (string | null);
      public requestTimestamp?: (number | Long$1 | null);
      public static create(properties?: proto.Message.IStickerSyncRMRMessage): proto.Message.StickerSyncRMRMessage;
      public static encode(m: proto.Message.IStickerSyncRMRMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.StickerSyncRMRMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.StickerSyncRMRMessage;
      public static toObject(m: proto.Message.StickerSyncRMRMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ITemplateButtonReplyMessage {
      selectedId?: (string | null);
      selectedDisplayText?: (string | null);
      contextInfo?: (proto.IContextInfo | null);
      selectedIndex?: (number | null);
      selectedCarouselCardIndex?: (number | null);
    }
    class TemplateButtonReplyMessage implements ITemplateButtonReplyMessage {
      constructor(p?: proto.Message.ITemplateButtonReplyMessage);
      public selectedId?: (string | null);
      public selectedDisplayText?: (string | null);
      public contextInfo?: (proto.IContextInfo | null);
      public selectedIndex?: (number | null);
      public selectedCarouselCardIndex?: (number | null);
      public static create(properties?: proto.Message.ITemplateButtonReplyMessage): proto.Message.TemplateButtonReplyMessage;
      public static encode(m: proto.Message.ITemplateButtonReplyMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.TemplateButtonReplyMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.TemplateButtonReplyMessage;
      public static toObject(m: proto.Message.TemplateButtonReplyMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ITemplateMessage {
      contextInfo?: (proto.IContextInfo | null);
      hydratedTemplate?: (proto.Message.TemplateMessage.IHydratedFourRowTemplate | null);
      templateId?: (string | null);
      fourRowTemplate?: (proto.Message.TemplateMessage.IFourRowTemplate | null);
      hydratedFourRowTemplate?: (proto.Message.TemplateMessage.IHydratedFourRowTemplate | null);
      interactiveMessageTemplate?: (proto.Message.IInteractiveMessage | null);
    }
    class TemplateMessage implements ITemplateMessage {
      constructor(p?: proto.Message.ITemplateMessage);
      public contextInfo?: (proto.IContextInfo | null);
      public hydratedTemplate?: (proto.Message.TemplateMessage.IHydratedFourRowTemplate | null);
      public templateId?: (string | null);
      public fourRowTemplate?: (proto.Message.TemplateMessage.IFourRowTemplate | null);
      public hydratedFourRowTemplate?: (proto.Message.TemplateMessage.IHydratedFourRowTemplate | null);
      public interactiveMessageTemplate?: (proto.Message.IInteractiveMessage | null);
      public format?: ("fourRowTemplate" | "hydratedFourRowTemplate" | "interactiveMessageTemplate");
      public static create(properties?: proto.Message.ITemplateMessage): proto.Message.TemplateMessage;
      public static encode(m: proto.Message.ITemplateMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.TemplateMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.TemplateMessage;
      public static toObject(m: proto.Message.TemplateMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace TemplateMessage {
      interface IFourRowTemplate {
        content?: (proto.Message.IHighlyStructuredMessage | null);
        footer?: (proto.Message.IHighlyStructuredMessage | null);
        buttons?: (proto.ITemplateButton[] | null);
        documentMessage?: (proto.Message.IDocumentMessage | null);
        highlyStructuredMessage?: (proto.Message.IHighlyStructuredMessage | null);
        imageMessage?: (proto.Message.IImageMessage | null);
        videoMessage?: (proto.Message.IVideoMessage | null);
        locationMessage?: (proto.Message.ILocationMessage | null);
      }
      class FourRowTemplate implements IFourRowTemplate {
        constructor(p?: proto.Message.TemplateMessage.IFourRowTemplate);
        public content?: (proto.Message.IHighlyStructuredMessage | null);
        public footer?: (proto.Message.IHighlyStructuredMessage | null);
        public buttons: proto.ITemplateButton[];
        public documentMessage?: (proto.Message.IDocumentMessage | null);
        public highlyStructuredMessage?: (proto.Message.IHighlyStructuredMessage | null);
        public imageMessage?: (proto.Message.IImageMessage | null);
        public videoMessage?: (proto.Message.IVideoMessage | null);
        public locationMessage?: (proto.Message.ILocationMessage | null);
        public title?: ("documentMessage" | "highlyStructuredMessage" | "imageMessage" | "videoMessage" | "locationMessage");
        public static create(properties?: proto.Message.TemplateMessage.IFourRowTemplate): proto.Message.TemplateMessage.FourRowTemplate;
        public static encode(m: proto.Message.TemplateMessage.IFourRowTemplate, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.TemplateMessage.FourRowTemplate;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.TemplateMessage.FourRowTemplate;
        public static toObject(m: proto.Message.TemplateMessage.FourRowTemplate, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IHydratedFourRowTemplate {
        hydratedContentText?: (string | null);
        hydratedFooterText?: (string | null);
        hydratedButtons?: (proto.IHydratedTemplateButton[] | null);
        templateId?: (string | null);
        maskLinkedDevices?: (boolean | null);
        documentMessage?: (proto.Message.IDocumentMessage | null);
        hydratedTitleText?: (string | null);
        imageMessage?: (proto.Message.IImageMessage | null);
        videoMessage?: (proto.Message.IVideoMessage | null);
        locationMessage?: (proto.Message.ILocationMessage | null);
      }
      class HydratedFourRowTemplate implements IHydratedFourRowTemplate {
        constructor(p?: proto.Message.TemplateMessage.IHydratedFourRowTemplate);
        public hydratedContentText?: (string | null);
        public hydratedFooterText?: (string | null);
        public hydratedButtons: proto.IHydratedTemplateButton[];
        public templateId?: (string | null);
        public maskLinkedDevices?: (boolean | null);
        public documentMessage?: (proto.Message.IDocumentMessage | null);
        public hydratedTitleText?: (string | null);
        public imageMessage?: (proto.Message.IImageMessage | null);
        public videoMessage?: (proto.Message.IVideoMessage | null);
        public locationMessage?: (proto.Message.ILocationMessage | null);
        public title?: ("documentMessage" | "hydratedTitleText" | "imageMessage" | "videoMessage" | "locationMessage");
        public static create(properties?: proto.Message.TemplateMessage.IHydratedFourRowTemplate): proto.Message.TemplateMessage.HydratedFourRowTemplate;
        public static encode(m: proto.Message.TemplateMessage.IHydratedFourRowTemplate, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.TemplateMessage.HydratedFourRowTemplate;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.Message.TemplateMessage.HydratedFourRowTemplate;
        public static toObject(m: proto.Message.TemplateMessage.HydratedFourRowTemplate, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface IURLMetadata {
      fbExperimentId?: (number | null);
    }
    class URLMetadata implements IURLMetadata {
      constructor(p?: proto.Message.IURLMetadata);
      public fbExperimentId?: (number | null);
      public static create(properties?: proto.Message.IURLMetadata): proto.Message.URLMetadata;
      public static encode(m: proto.Message.IURLMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.URLMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.URLMetadata;
      public static toObject(m: proto.Message.URLMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IVideoEndCard {
      username?: (string | null);
      caption?: (string | null);
      thumbnailImageUrl?: (string | null);
      profilePictureUrl?: (string | null);
    }
    class VideoEndCard implements IVideoEndCard {
      constructor(p?: proto.Message.IVideoEndCard);
      public username: string;
      public caption: string;
      public thumbnailImageUrl: string;
      public profilePictureUrl: string;
      public static create(properties?: proto.Message.IVideoEndCard): proto.Message.VideoEndCard;
      public static encode(m: proto.Message.IVideoEndCard, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.VideoEndCard;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.VideoEndCard;
      public static toObject(m: proto.Message.VideoEndCard, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IVideoMessage {
      url?: (string | null);
      mimetype?: (string | null);
      fileSha256?: (Uint8Array | null);
      fileLength?: (number | Long$1 | null);
      seconds?: (number | null);
      mediaKey?: (Uint8Array | null);
      caption?: (string | null);
      gifPlayback?: (boolean | null);
      height?: (number | null);
      width?: (number | null);
      fileEncSha256?: (Uint8Array | null);
      interactiveAnnotations?: (proto.IInteractiveAnnotation[] | null);
      directPath?: (string | null);
      mediaKeyTimestamp?: (number | Long$1 | null);
      jpegThumbnail?: (Uint8Array | null);
      contextInfo?: (proto.IContextInfo | null);
      streamingSidecar?: (Uint8Array | null);
      gifAttribution?: (proto.Message.VideoMessage.Attribution | null);
      viewOnce?: (boolean | null);
      thumbnailDirectPath?: (string | null);
      thumbnailSha256?: (Uint8Array | null);
      thumbnailEncSha256?: (Uint8Array | null);
      staticUrl?: (string | null);
      annotations?: (proto.IInteractiveAnnotation[] | null);
      accessibilityLabel?: (string | null);
      processedVideos?: (proto.IProcessedVideo[] | null);
      externalShareFullVideoDurationInSeconds?: (number | null);
      motionPhotoPresentationOffsetMs?: (number | Long$1 | null);
      metadataUrl?: (string | null);
      videoSourceType?: (proto.Message.VideoMessage.VideoSourceType | null);
      mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
    }
    class VideoMessage implements IVideoMessage {
      constructor(p?: proto.Message.IVideoMessage);
      public url?: (string | null);
      public mimetype?: (string | null);
      public fileSha256?: (Uint8Array | null);
      public fileLength?: (number | Long$1 | null);
      public seconds?: (number | null);
      public mediaKey?: (Uint8Array | null);
      public caption?: (string | null);
      public gifPlayback?: (boolean | null);
      public height?: (number | null);
      public width?: (number | null);
      public fileEncSha256?: (Uint8Array | null);
      public interactiveAnnotations: proto.IInteractiveAnnotation[];
      public directPath?: (string | null);
      public mediaKeyTimestamp?: (number | Long$1 | null);
      public jpegThumbnail?: (Uint8Array | null);
      public contextInfo?: (proto.IContextInfo | null);
      public streamingSidecar?: (Uint8Array | null);
      public gifAttribution?: (proto.Message.VideoMessage.Attribution | null);
      public viewOnce?: (boolean | null);
      public thumbnailDirectPath?: (string | null);
      public thumbnailSha256?: (Uint8Array | null);
      public thumbnailEncSha256?: (Uint8Array | null);
      public staticUrl?: (string | null);
      public annotations: proto.IInteractiveAnnotation[];
      public accessibilityLabel?: (string | null);
      public processedVideos: proto.IProcessedVideo[];
      public externalShareFullVideoDurationInSeconds?: (number | null);
      public motionPhotoPresentationOffsetMs?: (number | Long$1 | null);
      public metadataUrl?: (string | null);
      public videoSourceType?: (proto.Message.VideoMessage.VideoSourceType | null);
      public mediaKeyDomain?: (proto.Message.MediaKeyDomain | null);
      public static create(properties?: proto.Message.IVideoMessage): proto.Message.VideoMessage;
      public static encode(m: proto.Message.IVideoMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.Message.VideoMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.Message.VideoMessage;
      public static toObject(m: proto.Message.VideoMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace VideoMessage {
      enum Attribution {
        NONE = 0,
        GIPHY = 1,
        TENOR = 2,
        KLIPY = 3
      }
      enum VideoSourceType {
        USER_VIDEO = 0,
        AI_GENERATED = 1
      }
    }
  }
  interface IMessageAddOn {
    messageAddOnType?: (proto.MessageAddOn.MessageAddOnType | null);
    messageAddOn?: (proto.IMessage | null);
    senderTimestampMs?: (number | Long$1 | null);
    serverTimestampMs?: (number | Long$1 | null);
    status?: (proto.WebMessageInfo.Status | null);
    addOnContextInfo?: (proto.IMessageAddOnContextInfo | null);
    messageAddOnKey?: (proto.IMessageKey | null);
    legacyMessage?: (proto.ILegacyMessage | null);
  }
  class MessageAddOn implements IMessageAddOn {
    constructor(p?: proto.IMessageAddOn);
    public messageAddOnType?: (proto.MessageAddOn.MessageAddOnType | null);
    public messageAddOn?: (proto.IMessage | null);
    public senderTimestampMs?: (number | Long$1 | null);
    public serverTimestampMs?: (number | Long$1 | null);
    public status?: (proto.WebMessageInfo.Status | null);
    public addOnContextInfo?: (proto.IMessageAddOnContextInfo | null);
    public messageAddOnKey?: (proto.IMessageKey | null);
    public legacyMessage?: (proto.ILegacyMessage | null);
    public static create(properties?: proto.IMessageAddOn): proto.MessageAddOn;
    public static encode(m: proto.IMessageAddOn, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MessageAddOn;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MessageAddOn;
    public static toObject(m: proto.MessageAddOn, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace MessageAddOn {
    enum MessageAddOnType {
      UNDEFINED = 0,
      REACTION = 1,
      EVENT_RESPONSE = 2,
      POLL_UPDATE = 3,
      PIN_IN_CHAT = 4
    }
  }
  interface IMessageAddOnContextInfo {
    messageAddOnDurationInSecs?: (number | null);
    messageAddOnExpiryType?: (proto.MessageContextInfo.MessageAddonExpiryType | null);
  }
  class MessageAddOnContextInfo implements IMessageAddOnContextInfo {
    constructor(p?: proto.IMessageAddOnContextInfo);
    public messageAddOnDurationInSecs?: (number | null);
    public messageAddOnExpiryType?: (proto.MessageContextInfo.MessageAddonExpiryType | null);
    public static create(properties?: proto.IMessageAddOnContextInfo): proto.MessageAddOnContextInfo;
    public static encode(m: proto.IMessageAddOnContextInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MessageAddOnContextInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MessageAddOnContextInfo;
    public static toObject(m: proto.MessageAddOnContextInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IMessageAssociation {
    associationType?: (proto.MessageAssociation.AssociationType | null);
    parentMessageKey?: (proto.IMessageKey | null);
    messageIndex?: (number | null);
  }
  class MessageAssociation implements IMessageAssociation {
    constructor(p?: proto.IMessageAssociation);
    public associationType?: (proto.MessageAssociation.AssociationType | null);
    public parentMessageKey?: (proto.IMessageKey | null);
    public messageIndex?: (number | null);
    public static create(properties?: proto.IMessageAssociation): proto.MessageAssociation;
    public static encode(m: proto.IMessageAssociation, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MessageAssociation;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MessageAssociation;
    public static toObject(m: proto.MessageAssociation, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace MessageAssociation {
    enum AssociationType {
      UNKNOWN = 0,
      MEDIA_ALBUM = 1,
      BOT_PLUGIN = 2,
      EVENT_COVER_IMAGE = 3,
      STATUS_POLL = 4,
      HD_VIDEO_DUAL_UPLOAD = 5,
      STATUS_EXTERNAL_RESHARE = 6,
      MEDIA_POLL = 7,
      STATUS_ADD_YOURS = 8,
      STATUS_NOTIFICATION = 9,
      HD_IMAGE_DUAL_UPLOAD = 10,
      STICKER_ANNOTATION = 11,
      MOTION_PHOTO = 12,
      STATUS_LINK_ACTION = 13,
      VIEW_ALL_REPLIES = 14,
      STATUS_ADD_YOURS_AI_IMAGINE = 15,
      STATUS_QUESTION = 16,
      STATUS_ADD_YOURS_DIWALI = 17,
      STATUS_REACTION = 18,
      HEVC_VIDEO_DUAL_UPLOAD = 19
    }
  }
  interface IMessageContextInfo {
    deviceListMetadata?: (proto.IDeviceListMetadata | null);
    deviceListMetadataVersion?: (number | null);
    messageSecret?: (Uint8Array | null);
    paddingBytes?: (Uint8Array | null);
    messageAddOnDurationInSecs?: (number | null);
    botMessageSecret?: (Uint8Array | null);
    botMetadata?: (proto.IBotMetadata | null);
    reportingTokenVersion?: (number | null);
    messageAddOnExpiryType?: (proto.MessageContextInfo.MessageAddonExpiryType | null);
    messageAssociation?: (proto.IMessageAssociation | null);
    capiCreatedGroup?: (boolean | null);
    supportPayload?: (string | null);
    limitSharing?: (proto.ILimitSharing | null);
    limitSharingV2?: (proto.ILimitSharing | null);
    threadId?: (proto.IThreadID[] | null);
    weblinkRenderConfig?: (proto.WebLinkRenderConfig | null);
  }
  class MessageContextInfo implements IMessageContextInfo {
    constructor(p?: proto.IMessageContextInfo);
    public deviceListMetadata?: (proto.IDeviceListMetadata | null);
    public deviceListMetadataVersion?: (number | null);
    public messageSecret?: (Uint8Array | null);
    public paddingBytes?: (Uint8Array | null);
    public messageAddOnDurationInSecs?: (number | null);
    public botMessageSecret?: (Uint8Array | null);
    public botMetadata?: (proto.IBotMetadata | null);
    public reportingTokenVersion?: (number | null);
    public messageAddOnExpiryType?: (proto.MessageContextInfo.MessageAddonExpiryType | null);
    public messageAssociation?: (proto.IMessageAssociation | null);
    public capiCreatedGroup?: (boolean | null);
    public supportPayload?: (string | null);
    public limitSharing?: (proto.ILimitSharing | null);
    public limitSharingV2?: (proto.ILimitSharing | null);
    public threadId: proto.IThreadID[];
    public weblinkRenderConfig?: (proto.WebLinkRenderConfig | null);
    public static create(properties?: proto.IMessageContextInfo): proto.MessageContextInfo;
    public static encode(m: proto.IMessageContextInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MessageContextInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MessageContextInfo;
    public static toObject(m: proto.MessageContextInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace MessageContextInfo {
    enum MessageAddonExpiryType {
      STATIC = 1,
      DEPENDENT_ON_PARENT = 2
    }
  }
  interface IMessageKey {
    remoteJid?: (string | null);
    fromMe?: (boolean | null);
    id?: (string | null);
    participant?: (string | null);
  }
  class MessageKey implements IMessageKey {
    constructor(p?: proto.IMessageKey);
    public remoteJid?: (string | null);
    public fromMe?: (boolean | null);
    public id?: (string | null);
    public participant?: (string | null);
    public static create(properties?: proto.IMessageKey): proto.MessageKey;
    public static encode(m: proto.IMessageKey, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MessageKey;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MessageKey;
    public static toObject(m: proto.MessageKey, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IMessageSecretMessage {
    version?: (number | null);
    encIv?: (Uint8Array | null);
    encPayload?: (Uint8Array | null);
  }
  class MessageSecretMessage implements IMessageSecretMessage {
    constructor(p?: proto.IMessageSecretMessage);
    public version?: (number | null);
    public encIv?: (Uint8Array | null);
    public encPayload?: (Uint8Array | null);
    public static create(properties?: proto.IMessageSecretMessage): proto.MessageSecretMessage;
    public static encode(m: proto.IMessageSecretMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MessageSecretMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MessageSecretMessage;
    public static toObject(m: proto.MessageSecretMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IMoney {
    value?: (number | Long$1 | null);
    offset?: (number | null);
    currencyCode?: (string | null);
  }
  class Money implements IMoney {
    constructor(p?: proto.IMoney);
    public value?: (number | Long$1 | null);
    public offset?: (number | null);
    public currencyCode?: (string | null);
    public static create(properties?: proto.IMoney): proto.Money;
    public static encode(m: proto.IMoney, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Money;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Money;
    public static toObject(m: proto.Money, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IMsgOpaqueData {
    body?: (string | null);
    caption?: (string | null);
    lng?: (number | null);
    isLive?: (boolean | null);
    lat?: (number | null);
    paymentAmount1000?: (number | null);
    paymentNoteMsgBody?: (string | null);
    matchedText?: (string | null);
    title?: (string | null);
    description?: (string | null);
    futureproofBuffer?: (Uint8Array | null);
    clientUrl?: (string | null);
    loc?: (string | null);
    pollName?: (string | null);
    pollOptions?: (proto.MsgOpaqueData.IPollOption[] | null);
    pollSelectableOptionsCount?: (number | null);
    messageSecret?: (Uint8Array | null);
    originalSelfAuthor?: (string | null);
    senderTimestampMs?: (number | Long$1 | null);
    pollUpdateParentKey?: (string | null);
    encPollVote?: (proto.IPollEncValue | null);
    isSentCagPollCreation?: (boolean | null);
    pollContentType?: (proto.MsgOpaqueData.PollContentType | null);
    pollType?: (proto.MsgOpaqueData.PollType | null);
    correctOptionIndex?: (number | null);
    pollVotesSnapshot?: (proto.MsgOpaqueData.IPollVotesSnapshot | null);
    encReactionTargetMessageKey?: (string | null);
    encReactionEncPayload?: (Uint8Array | null);
    encReactionEncIv?: (Uint8Array | null);
    botMessageSecret?: (Uint8Array | null);
    targetMessageKey?: (string | null);
    encPayload?: (Uint8Array | null);
    encIv?: (Uint8Array | null);
    eventName?: (string | null);
    isEventCanceled?: (boolean | null);
    eventDescription?: (string | null);
    eventJoinLink?: (string | null);
    eventStartTime?: (number | Long$1 | null);
    eventLocation?: (proto.MsgOpaqueData.IEventLocation | null);
    eventEndTime?: (number | Long$1 | null);
    eventIsScheduledCall?: (boolean | null);
    eventExtraGuestsAllowed?: (boolean | null);
    plainProtobufBytes?: (Uint8Array | null);
  }
  class MsgOpaqueData implements IMsgOpaqueData {
    constructor(p?: proto.IMsgOpaqueData);
    public body?: (string | null);
    public caption?: (string | null);
    public lng?: (number | null);
    public isLive?: (boolean | null);
    public lat?: (number | null);
    public paymentAmount1000?: (number | null);
    public paymentNoteMsgBody?: (string | null);
    public matchedText?: (string | null);
    public title?: (string | null);
    public description?: (string | null);
    public futureproofBuffer?: (Uint8Array | null);
    public clientUrl?: (string | null);
    public loc?: (string | null);
    public pollName?: (string | null);
    public pollOptions: proto.MsgOpaqueData.IPollOption[];
    public pollSelectableOptionsCount?: (number | null);
    public messageSecret?: (Uint8Array | null);
    public originalSelfAuthor?: (string | null);
    public senderTimestampMs?: (number | Long$1 | null);
    public pollUpdateParentKey?: (string | null);
    public encPollVote?: (proto.IPollEncValue | null);
    public isSentCagPollCreation?: (boolean | null);
    public pollContentType?: (proto.MsgOpaqueData.PollContentType | null);
    public pollType?: (proto.MsgOpaqueData.PollType | null);
    public correctOptionIndex?: (number | null);
    public pollVotesSnapshot?: (proto.MsgOpaqueData.IPollVotesSnapshot | null);
    public encReactionTargetMessageKey?: (string | null);
    public encReactionEncPayload?: (Uint8Array | null);
    public encReactionEncIv?: (Uint8Array | null);
    public botMessageSecret?: (Uint8Array | null);
    public targetMessageKey?: (string | null);
    public encPayload?: (Uint8Array | null);
    public encIv?: (Uint8Array | null);
    public eventName?: (string | null);
    public isEventCanceled?: (boolean | null);
    public eventDescription?: (string | null);
    public eventJoinLink?: (string | null);
    public eventStartTime?: (number | Long$1 | null);
    public eventLocation?: (proto.MsgOpaqueData.IEventLocation | null);
    public eventEndTime?: (number | Long$1 | null);
    public eventIsScheduledCall?: (boolean | null);
    public eventExtraGuestsAllowed?: (boolean | null);
    public plainProtobufBytes?: (Uint8Array | null);
    public static create(properties?: proto.IMsgOpaqueData): proto.MsgOpaqueData;
    public static encode(m: proto.IMsgOpaqueData, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MsgOpaqueData;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MsgOpaqueData;
    public static toObject(m: proto.MsgOpaqueData, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace MsgOpaqueData {
    interface IEventLocation {
      degreesLatitude?: (number | null);
      degreesLongitude?: (number | null);
      name?: (string | null);
      address?: (string | null);
      url?: (string | null);
      jpegThumbnail?: (Uint8Array | null);
    }
    class EventLocation implements IEventLocation {
      constructor(p?: proto.MsgOpaqueData.IEventLocation);
      public degreesLatitude?: (number | null);
      public degreesLongitude?: (number | null);
      public name?: (string | null);
      public address?: (string | null);
      public url?: (string | null);
      public jpegThumbnail?: (Uint8Array | null);
      public static create(properties?: proto.MsgOpaqueData.IEventLocation): proto.MsgOpaqueData.EventLocation;
      public static encode(m: proto.MsgOpaqueData.IEventLocation, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.MsgOpaqueData.EventLocation;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.MsgOpaqueData.EventLocation;
      public static toObject(m: proto.MsgOpaqueData.EventLocation, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum PollContentType {
      UNKNOWN = 0,
      TEXT = 1,
      IMAGE = 2
    }
    interface IPollOption {
      name?: (string | null);
      hash?: (string | null);
    }
    class PollOption implements IPollOption {
      constructor(p?: proto.MsgOpaqueData.IPollOption);
      public name?: (string | null);
      public hash?: (string | null);
      public static create(properties?: proto.MsgOpaqueData.IPollOption): proto.MsgOpaqueData.PollOption;
      public static encode(m: proto.MsgOpaqueData.IPollOption, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.MsgOpaqueData.PollOption;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.MsgOpaqueData.PollOption;
      public static toObject(m: proto.MsgOpaqueData.PollOption, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum PollType {
      POLL = 0,
      QUIZ = 1
    }
    interface IPollVoteSnapshot {
      option?: (proto.MsgOpaqueData.IPollOption | null);
      optionVoteCount?: (number | null);
    }
    class PollVoteSnapshot implements IPollVoteSnapshot {
      constructor(p?: proto.MsgOpaqueData.IPollVoteSnapshot);
      public option?: (proto.MsgOpaqueData.IPollOption | null);
      public optionVoteCount?: (number | null);
      public static create(properties?: proto.MsgOpaqueData.IPollVoteSnapshot): proto.MsgOpaqueData.PollVoteSnapshot;
      public static encode(m: proto.MsgOpaqueData.IPollVoteSnapshot, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.MsgOpaqueData.PollVoteSnapshot;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.MsgOpaqueData.PollVoteSnapshot;
      public static toObject(m: proto.MsgOpaqueData.PollVoteSnapshot, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPollVotesSnapshot {
      pollVotes?: (proto.MsgOpaqueData.IPollVoteSnapshot[] | null);
    }
    class PollVotesSnapshot implements IPollVotesSnapshot {
      constructor(p?: proto.MsgOpaqueData.IPollVotesSnapshot);
      public pollVotes: proto.MsgOpaqueData.IPollVoteSnapshot[];
      public static create(properties?: proto.MsgOpaqueData.IPollVotesSnapshot): proto.MsgOpaqueData.PollVotesSnapshot;
      public static encode(m: proto.MsgOpaqueData.IPollVotesSnapshot, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.MsgOpaqueData.PollVotesSnapshot;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.MsgOpaqueData.PollVotesSnapshot;
      public static toObject(m: proto.MsgOpaqueData.PollVotesSnapshot, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IMsgRowOpaqueData {
    currentMsg?: (proto.IMsgOpaqueData | null);
    quotedMsg?: (proto.IMsgOpaqueData | null);
  }
  class MsgRowOpaqueData implements IMsgRowOpaqueData {
    constructor(p?: proto.IMsgRowOpaqueData);
    public currentMsg?: (proto.IMsgOpaqueData | null);
    public quotedMsg?: (proto.IMsgOpaqueData | null);
    public static create(properties?: proto.IMsgRowOpaqueData): proto.MsgRowOpaqueData;
    public static encode(m: proto.IMsgRowOpaqueData, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.MsgRowOpaqueData;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.MsgRowOpaqueData;
    public static toObject(m: proto.MsgRowOpaqueData, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  enum MutationProps {
    STAR_ACTION = 2,
    CONTACT_ACTION = 3,
    MUTE_ACTION = 4,
    PIN_ACTION = 5,
    SECURITY_NOTIFICATION_SETTING = 6,
    PUSH_NAME_SETTING = 7,
    QUICK_REPLY_ACTION = 8,
    RECENT_EMOJI_WEIGHTS_ACTION = 11,
    LABEL_MESSAGE_ACTION = 13,
    LABEL_EDIT_ACTION = 14,
    LABEL_ASSOCIATION_ACTION = 15,
    LOCALE_SETTING = 16,
    ARCHIVE_CHAT_ACTION = 17,
    DELETE_MESSAGE_FOR_ME_ACTION = 18,
    KEY_EXPIRATION = 19,
    MARK_CHAT_AS_READ_ACTION = 20,
    CLEAR_CHAT_ACTION = 21,
    DELETE_CHAT_ACTION = 22,
    UNARCHIVE_CHATS_SETTING = 23,
    PRIMARY_FEATURE = 24,
    ANDROID_UNSUPPORTED_ACTIONS = 26,
    AGENT_ACTION = 27,
    SUBSCRIPTION_ACTION = 28,
    USER_STATUS_MUTE_ACTION = 29,
    TIME_FORMAT_ACTION = 30,
    NUX_ACTION = 31,
    PRIMARY_VERSION_ACTION = 32,
    STICKER_ACTION = 33,
    REMOVE_RECENT_STICKER_ACTION = 34,
    CHAT_ASSIGNMENT = 35,
    CHAT_ASSIGNMENT_OPENED_STATUS = 36,
    PN_FOR_LID_CHAT_ACTION = 37,
    MARKETING_MESSAGE_ACTION = 38,
    MARKETING_MESSAGE_BROADCAST_ACTION = 39,
    EXTERNAL_WEB_BETA_ACTION = 40,
    PRIVACY_SETTING_RELAY_ALL_CALLS = 41,
    CALL_LOG_ACTION = 42,
    UGC_BOT = 43,
    STATUS_PRIVACY = 44,
    BOT_WELCOME_REQUEST_ACTION = 45,
    DELETE_INDIVIDUAL_CALL_LOG = 46,
    LABEL_REORDERING_ACTION = 47,
    PAYMENT_INFO_ACTION = 48,
    CUSTOM_PAYMENT_METHODS_ACTION = 49,
    LOCK_CHAT_ACTION = 50,
    CHAT_LOCK_SETTINGS = 51,
    WAMO_USER_IDENTIFIER_ACTION = 52,
    PRIVACY_SETTING_DISABLE_LINK_PREVIEWS_ACTION = 53,
    DEVICE_CAPABILITIES = 54,
    NOTE_EDIT_ACTION = 55,
    FAVORITES_ACTION = 56,
    MERCHANT_PAYMENT_PARTNER_ACTION = 57,
    WAFFLE_ACCOUNT_LINK_STATE_ACTION = 58,
    USERNAME_CHAT_START_MODE = 59,
    NOTIFICATION_ACTIVITY_SETTING_ACTION = 60,
    LID_CONTACT_ACTION = 61,
    CTWA_PER_CUSTOMER_DATA_SHARING_ACTION = 62,
    PAYMENT_TOS_ACTION = 63,
    PRIVACY_SETTING_CHANNELS_PERSONALISED_RECOMMENDATION_ACTION = 64,
    BUSINESS_BROADCAST_ASSOCIATION_ACTION = 65,
    DETECTED_OUTCOMES_STATUS_ACTION = 66,
    MAIBA_AI_FEATURES_CONTROL_ACTION = 68,
    BUSINESS_BROADCAST_LIST_ACTION = 69,
    MUSIC_USER_ID_ACTION = 70,
    STATUS_POST_OPT_IN_NOTIFICATION_PREFERENCES_ACTION = 71,
    AVATAR_UPDATED_ACTION = 72,
    GALAXY_FLOW_ACTION = 73,
    PRIVATE_PROCESSING_SETTING_ACTION = 74,
    NEWSLETTER_SAVED_INTERESTS_ACTION = 75,
    AI_THREAD_RENAME_ACTION = 76,
    INTERACTIVE_MESSAGE_ACTION = 77,
    SHARE_OWN_PN = 10001,
    BUSINESS_BROADCAST_ACTION = 10002
  }
  interface INoiseCertificate {
    details?: (Uint8Array | null);
    signature?: (Uint8Array | null);
  }
  class NoiseCertificate implements INoiseCertificate {
    constructor(p?: proto.INoiseCertificate);
    public details?: (Uint8Array | null);
    public signature?: (Uint8Array | null);
    public static create(properties?: proto.INoiseCertificate): proto.NoiseCertificate;
    public static encode(m: proto.INoiseCertificate, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.NoiseCertificate;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.NoiseCertificate;
    public static toObject(m: proto.NoiseCertificate, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace NoiseCertificate {
    interface IDetails {
      serial?: (number | null);
      issuer?: (string | null);
      expires?: (number | Long$1 | null);
      subject?: (string | null);
      key?: (Uint8Array | null);
    }
    class Details implements IDetails {
      constructor(p?: proto.NoiseCertificate.IDetails);
      public serial?: (number | null);
      public issuer?: (string | null);
      public expires?: (number | Long$1 | null);
      public subject?: (string | null);
      public key?: (Uint8Array | null);
      public static create(properties?: proto.NoiseCertificate.IDetails): proto.NoiseCertificate.Details;
      public static encode(m: proto.NoiseCertificate.IDetails, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.NoiseCertificate.Details;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.NoiseCertificate.Details;
      public static toObject(m: proto.NoiseCertificate.Details, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface INotificationMessageInfo {
    key?: (proto.IMessageKey | null);
    message?: (proto.IMessage | null);
    messageTimestamp?: (number | Long$1 | null);
    participant?: (string | null);
  }
  class NotificationMessageInfo implements INotificationMessageInfo {
    constructor(p?: proto.INotificationMessageInfo);
    public key?: (proto.IMessageKey | null);
    public message?: (proto.IMessage | null);
    public messageTimestamp?: (number | Long$1 | null);
    public participant?: (string | null);
    public static create(properties?: proto.INotificationMessageInfo): proto.NotificationMessageInfo;
    public static encode(m: proto.INotificationMessageInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.NotificationMessageInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.NotificationMessageInfo;
    public static toObject(m: proto.NotificationMessageInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface INotificationSettings {
    messageVibrate?: (string | null);
    messagePopup?: (string | null);
    messageLight?: (string | null);
    lowPriorityNotifications?: (boolean | null);
    reactionsMuted?: (boolean | null);
    callVibrate?: (string | null);
  }
  class NotificationSettings implements INotificationSettings {
    constructor(p?: proto.INotificationSettings);
    public messageVibrate?: (string | null);
    public messagePopup?: (string | null);
    public messageLight?: (string | null);
    public lowPriorityNotifications?: (boolean | null);
    public reactionsMuted?: (boolean | null);
    public callVibrate?: (string | null);
    public static create(properties?: proto.INotificationSettings): proto.NotificationSettings;
    public static encode(m: proto.INotificationSettings, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.NotificationSettings;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.NotificationSettings;
    public static toObject(m: proto.NotificationSettings, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPairingRequest {
    companionPublicKey?: (Uint8Array | null);
    companionIdentityKey?: (Uint8Array | null);
    advSecret?: (Uint8Array | null);
  }
  class PairingRequest implements IPairingRequest {
    constructor(p?: proto.IPairingRequest);
    public companionPublicKey?: (Uint8Array | null);
    public companionIdentityKey?: (Uint8Array | null);
    public advSecret?: (Uint8Array | null);
    public static create(properties?: proto.IPairingRequest): proto.PairingRequest;
    public static encode(m: proto.IPairingRequest, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PairingRequest;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PairingRequest;
    public static toObject(m: proto.PairingRequest, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPastParticipant {
    userJid?: (string | null);
    leaveReason?: (proto.PastParticipant.LeaveReason | null);
    leaveTs?: (number | Long$1 | null);
  }
  class PastParticipant implements IPastParticipant {
    constructor(p?: proto.IPastParticipant);
    public userJid?: (string | null);
    public leaveReason?: (proto.PastParticipant.LeaveReason | null);
    public leaveTs?: (number | Long$1 | null);
    public static create(properties?: proto.IPastParticipant): proto.PastParticipant;
    public static encode(m: proto.IPastParticipant, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PastParticipant;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PastParticipant;
    public static toObject(m: proto.PastParticipant, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace PastParticipant {
    enum LeaveReason {
      LEFT = 0,
      REMOVED = 1
    }
  }
  interface IPastParticipants {
    groupJid?: (string | null);
    pastParticipants?: (proto.IPastParticipant[] | null);
  }
  class PastParticipants implements IPastParticipants {
    constructor(p?: proto.IPastParticipants);
    public groupJid?: (string | null);
    public pastParticipants: proto.IPastParticipant[];
    public static create(properties?: proto.IPastParticipants): proto.PastParticipants;
    public static encode(m: proto.IPastParticipants, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PastParticipants;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PastParticipants;
    public static toObject(m: proto.PastParticipants, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPatchDebugData {
    currentLthash?: (Uint8Array | null);
    newLthash?: (Uint8Array | null);
    patchVersion?: (Uint8Array | null);
    collectionName?: (Uint8Array | null);
    firstFourBytesFromAHashOfSnapshotMacKey?: (Uint8Array | null);
    newLthashSubtract?: (Uint8Array | null);
    numberAdd?: (number | null);
    numberRemove?: (number | null);
    numberOverride?: (number | null);
    senderPlatform?: (proto.PatchDebugData.Platform | null);
    isSenderPrimary?: (boolean | null);
  }
  class PatchDebugData implements IPatchDebugData {
    constructor(p?: proto.IPatchDebugData);
    public currentLthash?: (Uint8Array | null);
    public newLthash?: (Uint8Array | null);
    public patchVersion?: (Uint8Array | null);
    public collectionName?: (Uint8Array | null);
    public firstFourBytesFromAHashOfSnapshotMacKey?: (Uint8Array | null);
    public newLthashSubtract?: (Uint8Array | null);
    public numberAdd?: (number | null);
    public numberRemove?: (number | null);
    public numberOverride?: (number | null);
    public senderPlatform?: (proto.PatchDebugData.Platform | null);
    public isSenderPrimary?: (boolean | null);
    public static create(properties?: proto.IPatchDebugData): proto.PatchDebugData;
    public static encode(m: proto.IPatchDebugData, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PatchDebugData;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PatchDebugData;
    public static toObject(m: proto.PatchDebugData, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace PatchDebugData {
    enum Platform {
      ANDROID = 0,
      SMBA = 1,
      IPHONE = 2,
      SMBI = 3,
      WEB = 4,
      UWP = 5,
      DARWIN = 6,
      IPAD = 7,
      WEAROS = 8,
      WASG = 9,
      WEARM = 10,
      CAPI = 11
    }
  }
  interface IPaymentBackground {
    id?: (string | null);
    fileLength?: (number | Long$1 | null);
    width?: (number | null);
    height?: (number | null);
    mimetype?: (string | null);
    placeholderArgb?: (number | null);
    textArgb?: (number | null);
    subtextArgb?: (number | null);
    mediaData?: (proto.PaymentBackground.IMediaData | null);
    type?: (proto.PaymentBackground.Type | null);
  }
  class PaymentBackground implements IPaymentBackground {
    constructor(p?: proto.IPaymentBackground);
    public id?: (string | null);
    public fileLength?: (number | Long$1 | null);
    public width?: (number | null);
    public height?: (number | null);
    public mimetype?: (string | null);
    public placeholderArgb?: (number | null);
    public textArgb?: (number | null);
    public subtextArgb?: (number | null);
    public mediaData?: (proto.PaymentBackground.IMediaData | null);
    public type?: (proto.PaymentBackground.Type | null);
    public static create(properties?: proto.IPaymentBackground): proto.PaymentBackground;
    public static encode(m: proto.IPaymentBackground, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PaymentBackground;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PaymentBackground;
    public static toObject(m: proto.PaymentBackground, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace PaymentBackground {
    interface IMediaData {
      mediaKey?: (Uint8Array | null);
      mediaKeyTimestamp?: (number | Long$1 | null);
      fileSha256?: (Uint8Array | null);
      fileEncSha256?: (Uint8Array | null);
      directPath?: (string | null);
    }
    class MediaData implements IMediaData {
      constructor(p?: proto.PaymentBackground.IMediaData);
      public mediaKey?: (Uint8Array | null);
      public mediaKeyTimestamp?: (number | Long$1 | null);
      public fileSha256?: (Uint8Array | null);
      public fileEncSha256?: (Uint8Array | null);
      public directPath?: (string | null);
      public static create(properties?: proto.PaymentBackground.IMediaData): proto.PaymentBackground.MediaData;
      public static encode(m: proto.PaymentBackground.IMediaData, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.PaymentBackground.MediaData;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.PaymentBackground.MediaData;
      public static toObject(m: proto.PaymentBackground.MediaData, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    enum Type {
      UNKNOWN = 0,
      DEFAULT = 1
    }
  }
  interface IPaymentInfo {
    currencyDeprecated?: (proto.PaymentInfo.Currency | null);
    amount1000?: (number | Long$1 | null);
    receiverJid?: (string | null);
    status?: (proto.PaymentInfo.Status | null);
    transactionTimestamp?: (number | Long$1 | null);
    requestMessageKey?: (proto.IMessageKey | null);
    expiryTimestamp?: (number | Long$1 | null);
    futureproofed?: (boolean | null);
    currency?: (string | null);
    txnStatus?: (proto.PaymentInfo.TxnStatus | null);
    useNoviFiatFormat?: (boolean | null);
    primaryAmount?: (proto.IMoney | null);
    exchangeAmount?: (proto.IMoney | null);
  }
  class PaymentInfo implements IPaymentInfo {
    constructor(p?: proto.IPaymentInfo);
    public currencyDeprecated?: (proto.PaymentInfo.Currency | null);
    public amount1000?: (number | Long$1 | null);
    public receiverJid?: (string | null);
    public status?: (proto.PaymentInfo.Status | null);
    public transactionTimestamp?: (number | Long$1 | null);
    public requestMessageKey?: (proto.IMessageKey | null);
    public expiryTimestamp?: (number | Long$1 | null);
    public futureproofed?: (boolean | null);
    public currency?: (string | null);
    public txnStatus?: (proto.PaymentInfo.TxnStatus | null);
    public useNoviFiatFormat?: (boolean | null);
    public primaryAmount?: (proto.IMoney | null);
    public exchangeAmount?: (proto.IMoney | null);
    public static create(properties?: proto.IPaymentInfo): proto.PaymentInfo;
    public static encode(m: proto.IPaymentInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PaymentInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PaymentInfo;
    public static toObject(m: proto.PaymentInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace PaymentInfo {
    enum Currency {
      UNKNOWN_CURRENCY = 0,
      INR = 1
    }
    enum Status {
      UNKNOWN_STATUS = 0,
      PROCESSING = 1,
      SENT = 2,
      NEED_TO_ACCEPT = 3,
      COMPLETE = 4,
      COULD_NOT_COMPLETE = 5,
      REFUNDED = 6,
      EXPIRED = 7,
      REJECTED = 8,
      CANCELLED = 9,
      WAITING_FOR_PAYER = 10,
      WAITING = 11
    }
    enum TxnStatus {
      UNKNOWN = 0,
      PENDING_SETUP = 1,
      PENDING_RECEIVER_SETUP = 2,
      INIT = 3,
      SUCCESS = 4,
      COMPLETED = 5,
      FAILED = 6,
      FAILED_RISK = 7,
      FAILED_PROCESSING = 8,
      FAILED_RECEIVER_PROCESSING = 9,
      FAILED_DA = 10,
      FAILED_DA_FINAL = 11,
      REFUNDED_TXN = 12,
      REFUND_FAILED = 13,
      REFUND_FAILED_PROCESSING = 14,
      REFUND_FAILED_DA = 15,
      EXPIRED_TXN = 16,
      AUTH_CANCELED = 17,
      AUTH_CANCEL_FAILED_PROCESSING = 18,
      AUTH_CANCEL_FAILED = 19,
      COLLECT_INIT = 20,
      COLLECT_SUCCESS = 21,
      COLLECT_FAILED = 22,
      COLLECT_FAILED_RISK = 23,
      COLLECT_REJECTED = 24,
      COLLECT_EXPIRED = 25,
      COLLECT_CANCELED = 26,
      COLLECT_CANCELLING = 27,
      IN_REVIEW = 28,
      REVERSAL_SUCCESS = 29,
      REVERSAL_PENDING = 30,
      REFUND_PENDING = 31
    }
  }
  interface IPhoneNumberToLIDMapping {
    pnJid?: (string | null);
    lidJid?: (string | null);
  }
  class PhoneNumberToLIDMapping implements IPhoneNumberToLIDMapping {
    constructor(p?: proto.IPhoneNumberToLIDMapping);
    public pnJid?: (string | null);
    public lidJid?: (string | null);
    public static create(properties?: proto.IPhoneNumberToLIDMapping): proto.PhoneNumberToLIDMapping;
    public static encode(m: proto.IPhoneNumberToLIDMapping, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PhoneNumberToLIDMapping;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PhoneNumberToLIDMapping;
    public static toObject(m: proto.PhoneNumberToLIDMapping, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPhotoChange {
    oldPhoto?: (Uint8Array | null);
    newPhoto?: (Uint8Array | null);
    newPhotoId?: (number | null);
  }
  class PhotoChange implements IPhotoChange {
    constructor(p?: proto.IPhotoChange);
    public oldPhoto?: (Uint8Array | null);
    public newPhoto?: (Uint8Array | null);
    public newPhotoId?: (number | null);
    public static create(properties?: proto.IPhotoChange): proto.PhotoChange;
    public static encode(m: proto.IPhotoChange, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PhotoChange;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PhotoChange;
    public static toObject(m: proto.PhotoChange, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPinInChat {
    type?: (proto.PinInChat.Type | null);
    key?: (proto.IMessageKey | null);
    senderTimestampMs?: (number | Long$1 | null);
    serverTimestampMs?: (number | Long$1 | null);
    messageAddOnContextInfo?: (proto.IMessageAddOnContextInfo | null);
  }
  class PinInChat implements IPinInChat {
    constructor(p?: proto.IPinInChat);
    public type?: (proto.PinInChat.Type | null);
    public key?: (proto.IMessageKey | null);
    public senderTimestampMs?: (number | Long$1 | null);
    public serverTimestampMs?: (number | Long$1 | null);
    public messageAddOnContextInfo?: (proto.IMessageAddOnContextInfo | null);
    public static create(properties?: proto.IPinInChat): proto.PinInChat;
    public static encode(m: proto.IPinInChat, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PinInChat;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PinInChat;
    public static toObject(m: proto.PinInChat, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace PinInChat {
    enum Type {
      UNKNOWN_TYPE = 0,
      PIN_FOR_ALL = 1,
      UNPIN_FOR_ALL = 2
    }
  }
  interface IPoint {
    xDeprecated?: (number | null);
    yDeprecated?: (number | null);
    x?: (number | null);
    y?: (number | null);
  }
  class Point implements IPoint {
    constructor(p?: proto.IPoint);
    public xDeprecated?: (number | null);
    public yDeprecated?: (number | null);
    public x?: (number | null);
    public y?: (number | null);
    public static create(properties?: proto.IPoint): proto.Point;
    public static encode(m: proto.IPoint, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Point;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Point;
    public static toObject(m: proto.Point, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPollAdditionalMetadata {
    pollInvalidated?: (boolean | null);
  }
  class PollAdditionalMetadata implements IPollAdditionalMetadata {
    constructor(p?: proto.IPollAdditionalMetadata);
    public pollInvalidated?: (boolean | null);
    public static create(properties?: proto.IPollAdditionalMetadata): proto.PollAdditionalMetadata;
    public static encode(m: proto.IPollAdditionalMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PollAdditionalMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PollAdditionalMetadata;
    public static toObject(m: proto.PollAdditionalMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPollEncValue {
    encPayload?: (Uint8Array | null);
    encIv?: (Uint8Array | null);
  }
  class PollEncValue implements IPollEncValue {
    constructor(p?: proto.IPollEncValue);
    public encPayload?: (Uint8Array | null);
    public encIv?: (Uint8Array | null);
    public static create(properties?: proto.IPollEncValue): proto.PollEncValue;
    public static encode(m: proto.IPollEncValue, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PollEncValue;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PollEncValue;
    public static toObject(m: proto.PollEncValue, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPollUpdate {
    pollUpdateMessageKey?: (proto.IMessageKey | null);
    vote?: (proto.Message.IPollVoteMessage | null);
    senderTimestampMs?: (number | Long$1 | null);
    serverTimestampMs?: (number | Long$1 | null);
    unread?: (boolean | null);
  }
  class PollUpdate implements IPollUpdate {
    constructor(p?: proto.IPollUpdate);
    public pollUpdateMessageKey?: (proto.IMessageKey | null);
    public vote?: (proto.Message.IPollVoteMessage | null);
    public senderTimestampMs?: (number | Long$1 | null);
    public serverTimestampMs?: (number | Long$1 | null);
    public unread?: (boolean | null);
    public static create(properties?: proto.IPollUpdate): proto.PollUpdate;
    public static encode(m: proto.IPollUpdate, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PollUpdate;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PollUpdate;
    public static toObject(m: proto.PollUpdate, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPreKeyRecordStructure {
    id?: (number | null);
    publicKey?: (Uint8Array | null);
    privateKey?: (Uint8Array | null);
  }
  class PreKeyRecordStructure implements IPreKeyRecordStructure {
    constructor(p?: proto.IPreKeyRecordStructure);
    public id?: (number | null);
    public publicKey?: (Uint8Array | null);
    public privateKey?: (Uint8Array | null);
    public static create(properties?: proto.IPreKeyRecordStructure): proto.PreKeyRecordStructure;
    public static encode(m: proto.IPreKeyRecordStructure, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PreKeyRecordStructure;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PreKeyRecordStructure;
    public static toObject(m: proto.PreKeyRecordStructure, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPreKeySignalMessage {
    registrationId?: (number | null);
    preKeyId?: (number | null);
    signedPreKeyId?: (number | null);
    baseKey?: (Uint8Array | null);
    identityKey?: (Uint8Array | null);
    message?: (Uint8Array | null);
  }
  class PreKeySignalMessage implements IPreKeySignalMessage {
    constructor(p?: proto.IPreKeySignalMessage);
    public registrationId?: (number | null);
    public preKeyId?: (number | null);
    public signedPreKeyId?: (number | null);
    public baseKey?: (Uint8Array | null);
    public identityKey?: (Uint8Array | null);
    public message?: (Uint8Array | null);
    public static create(properties?: proto.IPreKeySignalMessage): proto.PreKeySignalMessage;
    public static encode(m: proto.IPreKeySignalMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PreKeySignalMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PreKeySignalMessage;
    public static toObject(m: proto.PreKeySignalMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPremiumMessageInfo {
    serverCampaignId?: (string | null);
  }
  class PremiumMessageInfo implements IPremiumMessageInfo {
    constructor(p?: proto.IPremiumMessageInfo);
    public serverCampaignId?: (string | null);
    public static create(properties?: proto.IPremiumMessageInfo): proto.PremiumMessageInfo;
    public static encode(m: proto.IPremiumMessageInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PremiumMessageInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PremiumMessageInfo;
    public static toObject(m: proto.PremiumMessageInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPrimaryEphemeralIdentity {
    publicKey?: (Uint8Array | null);
    nonce?: (Uint8Array | null);
  }
  class PrimaryEphemeralIdentity implements IPrimaryEphemeralIdentity {
    constructor(p?: proto.IPrimaryEphemeralIdentity);
    public publicKey?: (Uint8Array | null);
    public nonce?: (Uint8Array | null);
    public static create(properties?: proto.IPrimaryEphemeralIdentity): proto.PrimaryEphemeralIdentity;
    public static encode(m: proto.IPrimaryEphemeralIdentity, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.PrimaryEphemeralIdentity;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.PrimaryEphemeralIdentity;
    public static toObject(m: proto.PrimaryEphemeralIdentity, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  enum PrivacySystemMessage {
    E2EE_MSG = 1,
    NE2EE_SELF = 2,
    NE2EE_OTHER = 3
  }
  interface IProcessedVideo {
    directPath?: (string | null);
    fileSha256?: (Uint8Array | null);
    height?: (number | null);
    width?: (number | null);
    fileLength?: (number | Long$1 | null);
    bitrate?: (number | null);
    quality?: (proto.ProcessedVideo.VideoQuality | null);
    capabilities?: (string[] | null);
  }
  class ProcessedVideo implements IProcessedVideo {
    constructor(p?: proto.IProcessedVideo);
    public directPath?: (string | null);
    public fileSha256?: (Uint8Array | null);
    public height?: (number | null);
    public width?: (number | null);
    public fileLength?: (number | Long$1 | null);
    public bitrate?: (number | null);
    public quality?: (proto.ProcessedVideo.VideoQuality | null);
    public capabilities: string[];
    public static create(properties?: proto.IProcessedVideo): proto.ProcessedVideo;
    public static encode(m: proto.IProcessedVideo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ProcessedVideo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ProcessedVideo;
    public static toObject(m: proto.ProcessedVideo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace ProcessedVideo {
    enum VideoQuality {
      UNDEFINED = 0,
      LOW = 1,
      MID = 2,
      HIGH = 3
    }
  }
  interface IProloguePayload {
    companionEphemeralIdentity?: (Uint8Array | null);
    commitment?: (proto.ICompanionCommitment | null);
  }
  class ProloguePayload implements IProloguePayload {
    constructor(p?: proto.IProloguePayload);
    public companionEphemeralIdentity?: (Uint8Array | null);
    public commitment?: (proto.ICompanionCommitment | null);
    public static create(properties?: proto.IProloguePayload): proto.ProloguePayload;
    public static encode(m: proto.IProloguePayload, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ProloguePayload;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ProloguePayload;
    public static toObject(m: proto.ProloguePayload, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IPushname {
    id?: (string | null);
    pushname?: (string | null);
  }
  class Pushname implements IPushname {
    constructor(p?: proto.IPushname);
    public id?: (string | null);
    public pushname?: (string | null);
    public static create(properties?: proto.IPushname): proto.Pushname;
    public static encode(m: proto.IPushname, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Pushname;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Pushname;
    public static toObject(m: proto.Pushname, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IQuarantinedMessage {
    originalData?: (Uint8Array | null);
    extractedText?: (string | null);
  }
  class QuarantinedMessage implements IQuarantinedMessage {
    constructor(p?: proto.IQuarantinedMessage);
    public originalData?: (Uint8Array | null);
    public extractedText?: (string | null);
    public static create(properties?: proto.IQuarantinedMessage): proto.QuarantinedMessage;
    public static encode(m: proto.IQuarantinedMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.QuarantinedMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.QuarantinedMessage;
    public static toObject(m: proto.QuarantinedMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IReaction {
    key?: (proto.IMessageKey | null);
    text?: (string | null);
    groupingKey?: (string | null);
    senderTimestampMs?: (number | Long$1 | null);
    unread?: (boolean | null);
  }
  class Reaction implements IReaction {
    constructor(p?: proto.IReaction);
    public key?: (proto.IMessageKey | null);
    public text?: (string | null);
    public groupingKey?: (string | null);
    public senderTimestampMs?: (number | Long$1 | null);
    public unread?: (boolean | null);
    public static create(properties?: proto.IReaction): proto.Reaction;
    public static encode(m: proto.IReaction, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Reaction;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Reaction;
    public static toObject(m: proto.Reaction, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IRecentEmojiWeight {
    emoji?: (string | null);
    weight?: (number | null);
  }
  class RecentEmojiWeight implements IRecentEmojiWeight {
    constructor(p?: proto.IRecentEmojiWeight);
    public emoji?: (string | null);
    public weight?: (number | null);
    public static create(properties?: proto.IRecentEmojiWeight): proto.RecentEmojiWeight;
    public static encode(m: proto.IRecentEmojiWeight, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.RecentEmojiWeight;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.RecentEmojiWeight;
    public static toObject(m: proto.RecentEmojiWeight, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IRecordStructure {
    currentSession?: (proto.ISessionStructure | null);
    previousSessions?: (proto.ISessionStructure[] | null);
  }
  class RecordStructure implements IRecordStructure {
    constructor(p?: proto.IRecordStructure);
    public currentSession?: (proto.ISessionStructure | null);
    public previousSessions: proto.ISessionStructure[];
    public static create(properties?: proto.IRecordStructure): proto.RecordStructure;
    public static encode(m: proto.IRecordStructure, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.RecordStructure;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.RecordStructure;
    public static toObject(m: proto.RecordStructure, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IReportable {
    minVersion?: (number | null);
    maxVersion?: (number | null);
    notReportableMinVersion?: (number | null);
    never?: (boolean | null);
  }
  class Reportable implements IReportable {
    constructor(p?: proto.IReportable);
    public minVersion?: (number | null);
    public maxVersion?: (number | null);
    public notReportableMinVersion?: (number | null);
    public never?: (boolean | null);
    public static create(properties?: proto.IReportable): proto.Reportable;
    public static encode(m: proto.IReportable, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.Reportable;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.Reportable;
    public static toObject(m: proto.Reportable, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IReportingTokenInfo {
    reportingTag?: (Uint8Array | null);
  }
  class ReportingTokenInfo implements IReportingTokenInfo {
    constructor(p?: proto.IReportingTokenInfo);
    public reportingTag?: (Uint8Array | null);
    public static create(properties?: proto.IReportingTokenInfo): proto.ReportingTokenInfo;
    public static encode(m: proto.IReportingTokenInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ReportingTokenInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ReportingTokenInfo;
    public static toObject(m: proto.ReportingTokenInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISenderKeyDistributionMessage {
    id?: (number | null);
    iteration?: (number | null);
    chainKey?: (Uint8Array | null);
    signingKey?: (Uint8Array | null);
  }
  class SenderKeyDistributionMessage implements ISenderKeyDistributionMessage {
    constructor(p?: proto.ISenderKeyDistributionMessage);
    public id?: (number | null);
    public iteration?: (number | null);
    public chainKey?: (Uint8Array | null);
    public signingKey?: (Uint8Array | null);
    public static create(properties?: proto.ISenderKeyDistributionMessage): proto.SenderKeyDistributionMessage;
    public static encode(m: proto.ISenderKeyDistributionMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SenderKeyDistributionMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SenderKeyDistributionMessage;
    public static toObject(m: proto.SenderKeyDistributionMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISenderKeyMessage {
    id?: (number | null);
    iteration?: (number | null);
    ciphertext?: (Uint8Array | null);
  }
  class SenderKeyMessage implements ISenderKeyMessage {
    constructor(p?: proto.ISenderKeyMessage);
    public id?: (number | null);
    public iteration?: (number | null);
    public ciphertext?: (Uint8Array | null);
    public static create(properties?: proto.ISenderKeyMessage): proto.SenderKeyMessage;
    public static encode(m: proto.ISenderKeyMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SenderKeyMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SenderKeyMessage;
    public static toObject(m: proto.SenderKeyMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISenderKeyRecordStructure {
    senderKeyStates?: (proto.ISenderKeyStateStructure[] | null);
  }
  class SenderKeyRecordStructure implements ISenderKeyRecordStructure {
    constructor(p?: proto.ISenderKeyRecordStructure);
    public senderKeyStates: proto.ISenderKeyStateStructure[];
    public static create(properties?: proto.ISenderKeyRecordStructure): proto.SenderKeyRecordStructure;
    public static encode(m: proto.ISenderKeyRecordStructure, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SenderKeyRecordStructure;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SenderKeyRecordStructure;
    public static toObject(m: proto.SenderKeyRecordStructure, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISenderKeyStateStructure {
    senderKeyId?: (number | null);
    senderChainKey?: (proto.SenderKeyStateStructure.ISenderChainKey | null);
    senderSigningKey?: (proto.SenderKeyStateStructure.ISenderSigningKey | null);
    senderMessageKeys?: (proto.SenderKeyStateStructure.ISenderMessageKey[] | null);
  }
  class SenderKeyStateStructure implements ISenderKeyStateStructure {
    constructor(p?: proto.ISenderKeyStateStructure);
    public senderKeyId?: (number | null);
    public senderChainKey?: (proto.SenderKeyStateStructure.ISenderChainKey | null);
    public senderSigningKey?: (proto.SenderKeyStateStructure.ISenderSigningKey | null);
    public senderMessageKeys: proto.SenderKeyStateStructure.ISenderMessageKey[];
    public static create(properties?: proto.ISenderKeyStateStructure): proto.SenderKeyStateStructure;
    public static encode(m: proto.ISenderKeyStateStructure, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SenderKeyStateStructure;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SenderKeyStateStructure;
    public static toObject(m: proto.SenderKeyStateStructure, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace SenderKeyStateStructure {
    interface ISenderChainKey {
      iteration?: (number | null);
      seed?: (Uint8Array | null);
    }
    class SenderChainKey implements ISenderChainKey {
      constructor(p?: proto.SenderKeyStateStructure.ISenderChainKey);
      public iteration?: (number | null);
      public seed?: (Uint8Array | null);
      public static create(properties?: proto.SenderKeyStateStructure.ISenderChainKey): proto.SenderKeyStateStructure.SenderChainKey;
      public static encode(m: proto.SenderKeyStateStructure.ISenderChainKey, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SenderKeyStateStructure.SenderChainKey;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SenderKeyStateStructure.SenderChainKey;
      public static toObject(m: proto.SenderKeyStateStructure.SenderChainKey, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ISenderMessageKey {
      iteration?: (number | null);
      seed?: (Uint8Array | null);
    }
    class SenderMessageKey implements ISenderMessageKey {
      constructor(p?: proto.SenderKeyStateStructure.ISenderMessageKey);
      public iteration?: (number | null);
      public seed?: (Uint8Array | null);
      public static create(properties?: proto.SenderKeyStateStructure.ISenderMessageKey): proto.SenderKeyStateStructure.SenderMessageKey;
      public static encode(m: proto.SenderKeyStateStructure.ISenderMessageKey, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SenderKeyStateStructure.SenderMessageKey;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SenderKeyStateStructure.SenderMessageKey;
      public static toObject(m: proto.SenderKeyStateStructure.SenderMessageKey, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ISenderSigningKey {
      "public"?: (Uint8Array | null);
      "private"?: (Uint8Array | null);
    }
    class SenderSigningKey implements ISenderSigningKey {
      constructor(p?: proto.SenderKeyStateStructure.ISenderSigningKey);
      public public?: (Uint8Array | null);
      public private?: (Uint8Array | null);
      public static create(properties?: proto.SenderKeyStateStructure.ISenderSigningKey): proto.SenderKeyStateStructure.SenderSigningKey;
      public static encode(m: proto.SenderKeyStateStructure.ISenderSigningKey, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SenderKeyStateStructure.SenderSigningKey;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SenderKeyStateStructure.SenderSigningKey;
      public static toObject(m: proto.SenderKeyStateStructure.SenderSigningKey, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IServerErrorReceipt {
    stanzaId?: (string | null);
  }
  class ServerErrorReceipt implements IServerErrorReceipt {
    constructor(p?: proto.IServerErrorReceipt);
    public stanzaId?: (string | null);
    public static create(properties?: proto.IServerErrorReceipt): proto.ServerErrorReceipt;
    public static encode(m: proto.IServerErrorReceipt, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ServerErrorReceipt;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ServerErrorReceipt;
    public static toObject(m: proto.ServerErrorReceipt, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISessionStructure {
    sessionVersion?: (number | null);
    localIdentityPublic?: (Uint8Array | null);
    remoteIdentityPublic?: (Uint8Array | null);
    rootKey?: (Uint8Array | null);
    previousCounter?: (number | null);
    senderChain?: (proto.SessionStructure.IChain | null);
    receiverChains?: (proto.SessionStructure.IChain[] | null);
    pendingKeyExchange?: (proto.SessionStructure.IPendingKeyExchange | null);
    pendingPreKey?: (proto.SessionStructure.IPendingPreKey | null);
    remoteRegistrationId?: (number | null);
    localRegistrationId?: (number | null);
    needsRefresh?: (boolean | null);
    aliceBaseKey?: (Uint8Array | null);
  }
  class SessionStructure implements ISessionStructure {
    constructor(p?: proto.ISessionStructure);
    public sessionVersion?: (number | null);
    public localIdentityPublic?: (Uint8Array | null);
    public remoteIdentityPublic?: (Uint8Array | null);
    public rootKey?: (Uint8Array | null);
    public previousCounter?: (number | null);
    public senderChain?: (proto.SessionStructure.IChain | null);
    public receiverChains: proto.SessionStructure.IChain[];
    public pendingKeyExchange?: (proto.SessionStructure.IPendingKeyExchange | null);
    public pendingPreKey?: (proto.SessionStructure.IPendingPreKey | null);
    public remoteRegistrationId?: (number | null);
    public localRegistrationId?: (number | null);
    public needsRefresh?: (boolean | null);
    public aliceBaseKey?: (Uint8Array | null);
    public static create(properties?: proto.ISessionStructure): proto.SessionStructure;
    public static encode(m: proto.ISessionStructure, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SessionStructure;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SessionStructure;
    public static toObject(m: proto.SessionStructure, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace SessionStructure {
    interface IChain {
      senderRatchetKey?: (Uint8Array | null);
      senderRatchetKeyPrivate?: (Uint8Array | null);
      chainKey?: (proto.SessionStructure.Chain.IChainKey | null);
      messageKeys?: (proto.SessionStructure.Chain.IMessageKey[] | null);
    }
    class Chain implements IChain {
      constructor(p?: proto.SessionStructure.IChain);
      public senderRatchetKey?: (Uint8Array | null);
      public senderRatchetKeyPrivate?: (Uint8Array | null);
      public chainKey?: (proto.SessionStructure.Chain.IChainKey | null);
      public messageKeys: proto.SessionStructure.Chain.IMessageKey[];
      public static create(properties?: proto.SessionStructure.IChain): proto.SessionStructure.Chain;
      public static encode(m: proto.SessionStructure.IChain, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SessionStructure.Chain;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SessionStructure.Chain;
      public static toObject(m: proto.SessionStructure.Chain, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace Chain {
      interface IChainKey {
        index?: (number | null);
        key?: (Uint8Array | null);
      }
      class ChainKey implements IChainKey {
        constructor(p?: proto.SessionStructure.Chain.IChainKey);
        public index?: (number | null);
        public key?: (Uint8Array | null);
        public static create(properties?: proto.SessionStructure.Chain.IChainKey): proto.SessionStructure.Chain.ChainKey;
        public static encode(m: proto.SessionStructure.Chain.IChainKey, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.SessionStructure.Chain.ChainKey;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.SessionStructure.Chain.ChainKey;
        public static toObject(m: proto.SessionStructure.Chain.ChainKey, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      interface IMessageKey {
        index?: (number | null);
        cipherKey?: (Uint8Array | null);
        macKey?: (Uint8Array | null);
        iv?: (Uint8Array | null);
      }
      class MessageKey implements IMessageKey {
        constructor(p?: proto.SessionStructure.Chain.IMessageKey);
        public index?: (number | null);
        public cipherKey?: (Uint8Array | null);
        public macKey?: (Uint8Array | null);
        public iv?: (Uint8Array | null);
        public static create(properties?: proto.SessionStructure.Chain.IMessageKey): proto.SessionStructure.Chain.MessageKey;
        public static encode(m: proto.SessionStructure.Chain.IMessageKey, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.SessionStructure.Chain.MessageKey;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.SessionStructure.Chain.MessageKey;
        public static toObject(m: proto.SessionStructure.Chain.MessageKey, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface IPendingKeyExchange {
      sequence?: (number | null);
      localBaseKey?: (Uint8Array | null);
      localBaseKeyPrivate?: (Uint8Array | null);
      localRatchetKey?: (Uint8Array | null);
      localRatchetKeyPrivate?: (Uint8Array | null);
      localIdentityKey?: (Uint8Array | null);
      localIdentityKeyPrivate?: (Uint8Array | null);
    }
    class PendingKeyExchange implements IPendingKeyExchange {
      constructor(p?: proto.SessionStructure.IPendingKeyExchange);
      public sequence?: (number | null);
      public localBaseKey?: (Uint8Array | null);
      public localBaseKeyPrivate?: (Uint8Array | null);
      public localRatchetKey?: (Uint8Array | null);
      public localRatchetKeyPrivate?: (Uint8Array | null);
      public localIdentityKey?: (Uint8Array | null);
      public localIdentityKeyPrivate?: (Uint8Array | null);
      public static create(properties?: proto.SessionStructure.IPendingKeyExchange): proto.SessionStructure.PendingKeyExchange;
      public static encode(m: proto.SessionStructure.IPendingKeyExchange, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SessionStructure.PendingKeyExchange;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SessionStructure.PendingKeyExchange;
      public static toObject(m: proto.SessionStructure.PendingKeyExchange, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPendingPreKey {
      preKeyId?: (number | null);
      signedPreKeyId?: (number | null);
      baseKey?: (Uint8Array | null);
    }
    class PendingPreKey implements IPendingPreKey {
      constructor(p?: proto.SessionStructure.IPendingPreKey);
      public preKeyId?: (number | null);
      public signedPreKeyId?: (number | null);
      public baseKey?: (Uint8Array | null);
      public static create(properties?: proto.SessionStructure.IPendingPreKey): proto.SessionStructure.PendingPreKey;
      public static encode(m: proto.SessionStructure.IPendingPreKey, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SessionStructure.PendingPreKey;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SessionStructure.PendingPreKey;
      public static toObject(m: proto.SessionStructure.PendingPreKey, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface ISessionTransparencyMetadata {
    disclaimerText?: (string | null);
    hcaId?: (string | null);
    sessionTransparencyType?: (proto.SessionTransparencyType | null);
  }
  class SessionTransparencyMetadata implements ISessionTransparencyMetadata {
    constructor(p?: proto.ISessionTransparencyMetadata);
    public disclaimerText?: (string | null);
    public hcaId?: (string | null);
    public sessionTransparencyType?: (proto.SessionTransparencyType | null);
    public static create(properties?: proto.ISessionTransparencyMetadata): proto.SessionTransparencyMetadata;
    public static encode(m: proto.ISessionTransparencyMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SessionTransparencyMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SessionTransparencyMetadata;
    public static toObject(m: proto.SessionTransparencyMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  enum SessionTransparencyType {
    UNKNOWN_TYPE = 0,
    NY_AI_SAFETY_DISCLAIMER = 1
  }
  interface ISignalMessage {
    ratchetKey?: (Uint8Array | null);
    counter?: (number | null);
    previousCounter?: (number | null);
    ciphertext?: (Uint8Array | null);
  }
  class SignalMessage implements ISignalMessage {
    constructor(p?: proto.ISignalMessage);
    public ratchetKey?: (Uint8Array | null);
    public counter?: (number | null);
    public previousCounter?: (number | null);
    public ciphertext?: (Uint8Array | null);
    public static create(properties?: proto.ISignalMessage): proto.SignalMessage;
    public static encode(m: proto.ISignalMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SignalMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SignalMessage;
    public static toObject(m: proto.SignalMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISignedPreKeyRecordStructure {
    id?: (number | null);
    publicKey?: (Uint8Array | null);
    privateKey?: (Uint8Array | null);
    signature?: (Uint8Array | null);
    timestamp?: (number | Long$1 | null);
  }
  class SignedPreKeyRecordStructure implements ISignedPreKeyRecordStructure {
    constructor(p?: proto.ISignedPreKeyRecordStructure);
    public id?: (number | null);
    public publicKey?: (Uint8Array | null);
    public privateKey?: (Uint8Array | null);
    public signature?: (Uint8Array | null);
    public timestamp?: (number | Long$1 | null);
    public static create(properties?: proto.ISignedPreKeyRecordStructure): proto.SignedPreKeyRecordStructure;
    public static encode(m: proto.ISignedPreKeyRecordStructure, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SignedPreKeyRecordStructure;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SignedPreKeyRecordStructure;
    public static toObject(m: proto.SignedPreKeyRecordStructure, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IStatusAttribution {
    type?: (proto.StatusAttribution.Type | null);
    actionUrl?: (string | null);
    statusReshare?: (proto.StatusAttribution.IStatusReshare | null);
    externalShare?: (proto.StatusAttribution.IExternalShare | null);
    music?: (proto.StatusAttribution.IMusic | null);
    groupStatus?: (proto.StatusAttribution.IGroupStatus | null);
    rlAttribution?: (proto.StatusAttribution.IRLAttribution | null);
    aiCreatedAttribution?: (proto.StatusAttribution.IAiCreatedAttribution | null);
  }
  class StatusAttribution implements IStatusAttribution {
    constructor(p?: proto.IStatusAttribution);
    public type?: (proto.StatusAttribution.Type | null);
    public actionUrl?: (string | null);
    public statusReshare?: (proto.StatusAttribution.IStatusReshare | null);
    public externalShare?: (proto.StatusAttribution.IExternalShare | null);
    public music?: (proto.StatusAttribution.IMusic | null);
    public groupStatus?: (proto.StatusAttribution.IGroupStatus | null);
    public rlAttribution?: (proto.StatusAttribution.IRLAttribution | null);
    public aiCreatedAttribution?: (proto.StatusAttribution.IAiCreatedAttribution | null);
    public attributionData?: ("statusReshare" | "externalShare" | "music" | "groupStatus" | "rlAttribution" | "aiCreatedAttribution");
    public static create(properties?: proto.IStatusAttribution): proto.StatusAttribution;
    public static encode(m: proto.IStatusAttribution, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.StatusAttribution;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.StatusAttribution;
    public static toObject(m: proto.StatusAttribution, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace StatusAttribution {
    interface IAiCreatedAttribution {
      source?: (proto.StatusAttribution.AiCreatedAttribution.Source | null);
    }
    class AiCreatedAttribution implements IAiCreatedAttribution {
      constructor(p?: proto.StatusAttribution.IAiCreatedAttribution);
      public source?: (proto.StatusAttribution.AiCreatedAttribution.Source | null);
      public static create(properties?: proto.StatusAttribution.IAiCreatedAttribution): proto.StatusAttribution.AiCreatedAttribution;
      public static encode(m: proto.StatusAttribution.IAiCreatedAttribution, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.StatusAttribution.AiCreatedAttribution;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.StatusAttribution.AiCreatedAttribution;
      public static toObject(m: proto.StatusAttribution.AiCreatedAttribution, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace AiCreatedAttribution {
      enum Source {
        UNKNOWN = 0,
        STATUS_MIMICRY = 1
      }
    }
    interface IExternalShare {
      actionUrl?: (string | null);
      source?: (proto.StatusAttribution.ExternalShare.Source | null);
      duration?: (number | null);
      actionFallbackUrl?: (string | null);
    }
    class ExternalShare implements IExternalShare {
      constructor(p?: proto.StatusAttribution.IExternalShare);
      public actionUrl?: (string | null);
      public source?: (proto.StatusAttribution.ExternalShare.Source | null);
      public duration?: (number | null);
      public actionFallbackUrl?: (string | null);
      public static create(properties?: proto.StatusAttribution.IExternalShare): proto.StatusAttribution.ExternalShare;
      public static encode(m: proto.StatusAttribution.IExternalShare, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.StatusAttribution.ExternalShare;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.StatusAttribution.ExternalShare;
      public static toObject(m: proto.StatusAttribution.ExternalShare, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace ExternalShare {
      enum Source {
        UNKNOWN = 0,
        INSTAGRAM = 1,
        FACEBOOK = 2,
        MESSENGER = 3,
        SPOTIFY = 4,
        YOUTUBE = 5,
        PINTEREST = 6,
        THREADS = 7,
        APPLE_MUSIC = 8,
        SHARECHAT = 9,
        GOOGLE_PHOTOS = 10
      }
    }
    interface IGroupStatus {
      authorJid?: (string | null);
    }
    class GroupStatus implements IGroupStatus {
      constructor(p?: proto.StatusAttribution.IGroupStatus);
      public authorJid?: (string | null);
      public static create(properties?: proto.StatusAttribution.IGroupStatus): proto.StatusAttribution.GroupStatus;
      public static encode(m: proto.StatusAttribution.IGroupStatus, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.StatusAttribution.GroupStatus;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.StatusAttribution.GroupStatus;
      public static toObject(m: proto.StatusAttribution.GroupStatus, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IMusic {
      authorName?: (string | null);
      songId?: (string | null);
      title?: (string | null);
      author?: (string | null);
      artistAttribution?: (string | null);
      isExplicit?: (boolean | null);
    }
    class Music implements IMusic {
      constructor(p?: proto.StatusAttribution.IMusic);
      public authorName?: (string | null);
      public songId?: (string | null);
      public title?: (string | null);
      public author?: (string | null);
      public artistAttribution?: (string | null);
      public isExplicit?: (boolean | null);
      public static create(properties?: proto.StatusAttribution.IMusic): proto.StatusAttribution.Music;
      public static encode(m: proto.StatusAttribution.IMusic, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.StatusAttribution.Music;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.StatusAttribution.Music;
      public static toObject(m: proto.StatusAttribution.Music, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IRLAttribution {
      source?: (proto.StatusAttribution.RLAttribution.Source | null);
    }
    class RLAttribution implements IRLAttribution {
      constructor(p?: proto.StatusAttribution.IRLAttribution);
      public source?: (proto.StatusAttribution.RLAttribution.Source | null);
      public static create(properties?: proto.StatusAttribution.IRLAttribution): proto.StatusAttribution.RLAttribution;
      public static encode(m: proto.StatusAttribution.IRLAttribution, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.StatusAttribution.RLAttribution;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.StatusAttribution.RLAttribution;
      public static toObject(m: proto.StatusAttribution.RLAttribution, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace RLAttribution {
      enum Source {
        UNKNOWN = 0,
        RAY_BAN_META_GLASSES = 1,
        OAKLEY_META_GLASSES = 2,
        HYPERNOVA_GLASSES = 3
      }
    }
    interface IStatusReshare {
      source?: (proto.StatusAttribution.StatusReshare.Source | null);
      metadata?: (proto.StatusAttribution.StatusReshare.IMetadata | null);
    }
    class StatusReshare implements IStatusReshare {
      constructor(p?: proto.StatusAttribution.IStatusReshare);
      public source?: (proto.StatusAttribution.StatusReshare.Source | null);
      public metadata?: (proto.StatusAttribution.StatusReshare.IMetadata | null);
      public static create(properties?: proto.StatusAttribution.IStatusReshare): proto.StatusAttribution.StatusReshare;
      public static encode(m: proto.StatusAttribution.IStatusReshare, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.StatusAttribution.StatusReshare;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.StatusAttribution.StatusReshare;
      public static toObject(m: proto.StatusAttribution.StatusReshare, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace StatusReshare {
      interface IMetadata {
        duration?: (number | null);
        channelJid?: (string | null);
        channelMessageId?: (number | null);
        hasMultipleReshares?: (boolean | null);
      }
      class Metadata implements IMetadata {
        constructor(p?: proto.StatusAttribution.StatusReshare.IMetadata);
        public duration?: (number | null);
        public channelJid?: (string | null);
        public channelMessageId?: (number | null);
        public hasMultipleReshares?: (boolean | null);
        public static create(properties?: proto.StatusAttribution.StatusReshare.IMetadata): proto.StatusAttribution.StatusReshare.Metadata;
        public static encode(m: proto.StatusAttribution.StatusReshare.IMetadata, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.StatusAttribution.StatusReshare.Metadata;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.StatusAttribution.StatusReshare.Metadata;
        public static toObject(m: proto.StatusAttribution.StatusReshare.Metadata, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
      enum Source {
        UNKNOWN = 0,
        INTERNAL_RESHARE = 1,
        MENTION_RESHARE = 2,
        CHANNEL_RESHARE = 3,
        FORWARD = 4
      }
    }
    enum Type {
      UNKNOWN = 0,
      RESHARE = 1,
      EXTERNAL_SHARE = 2,
      MUSIC = 3,
      STATUS_MENTION = 4,
      GROUP_STATUS = 5,
      RL_ATTRIBUTION = 6,
      AI_CREATED = 7,
      LAYOUTS = 8
    }
  }
  interface IStatusMentionMessage {
    quotedStatus?: (proto.IMessage | null);
  }
  class StatusMentionMessage implements IStatusMentionMessage {
    constructor(p?: proto.IStatusMentionMessage);
    public quotedStatus?: (proto.IMessage | null);
    public static create(properties?: proto.IStatusMentionMessage): proto.StatusMentionMessage;
    public static encode(m: proto.IStatusMentionMessage, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.StatusMentionMessage;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.StatusMentionMessage;
    public static toObject(m: proto.StatusMentionMessage, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IStatusPSA {
    campaignId?: (number | Long$1 | null);
    campaignExpirationTimestamp?: (number | Long$1 | null);
  }
  class StatusPSA implements IStatusPSA {
    constructor(p?: proto.IStatusPSA);
    public campaignId: (number | Long$1);
    public campaignExpirationTimestamp?: (number | Long$1 | null);
    public static create(properties?: proto.IStatusPSA): proto.StatusPSA;
    public static encode(m: proto.IStatusPSA, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.StatusPSA;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.StatusPSA;
    public static toObject(m: proto.StatusPSA, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IStickerMetadata {
    url?: (string | null);
    fileSha256?: (Uint8Array | null);
    fileEncSha256?: (Uint8Array | null);
    mediaKey?: (Uint8Array | null);
    mimetype?: (string | null);
    height?: (number | null);
    width?: (number | null);
    directPath?: (string | null);
    fileLength?: (number | Long$1 | null);
    weight?: (number | null);
    lastStickerSentTs?: (number | Long$1 | null);
    isLottie?: (boolean | null);
    imageHash?: (string | null);
    isAvatarSticker?: (boolean | null);
  }
  class StickerMetadata implements IStickerMetadata {
    constructor(p?: proto.IStickerMetadata);
    public url?: (string | null);
    public fileSha256?: (Uint8Array | null);
    public fileEncSha256?: (Uint8Array | null);
    public mediaKey?: (Uint8Array | null);
    public mimetype?: (string | null);
    public height?: (number | null);
    public width?: (number | null);
    public directPath?: (string | null);
    public fileLength?: (number | Long$1 | null);
    public weight?: (number | null);
    public lastStickerSentTs?: (number | Long$1 | null);
    public isLottie?: (boolean | null);
    public imageHash?: (string | null);
    public isAvatarSticker?: (boolean | null);
    public static create(properties?: proto.IStickerMetadata): proto.StickerMetadata;
    public static encode(m: proto.IStickerMetadata, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.StickerMetadata;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.StickerMetadata;
    public static toObject(m: proto.StickerMetadata, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISyncActionData {
    index?: (Uint8Array | null);
    value?: (proto.ISyncActionValue | null);
    padding?: (Uint8Array | null);
    version?: (number | null);
  }
  class SyncActionData implements ISyncActionData {
    constructor(p?: proto.ISyncActionData);
    public index?: (Uint8Array | null);
    public value?: (proto.ISyncActionValue | null);
    public padding?: (Uint8Array | null);
    public version?: (number | null);
    public static create(properties?: proto.ISyncActionData): proto.SyncActionData;
    public static encode(m: proto.ISyncActionData, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionData;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SyncActionData;
    public static toObject(m: proto.SyncActionData, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISyncActionValue {
    timestamp?: (number | Long$1 | null);
    starAction?: (proto.SyncActionValue.IStarAction | null);
    contactAction?: (proto.SyncActionValue.IContactAction | null);
    muteAction?: (proto.SyncActionValue.IMuteAction | null);
    pinAction?: (proto.SyncActionValue.IPinAction | null);
    pushNameSetting?: (proto.SyncActionValue.IPushNameSetting | null);
    quickReplyAction?: (proto.SyncActionValue.IQuickReplyAction | null);
    recentEmojiWeightsAction?: (proto.SyncActionValue.IRecentEmojiWeightsAction | null);
    labelEditAction?: (proto.SyncActionValue.ILabelEditAction | null);
    labelAssociationAction?: (proto.SyncActionValue.ILabelAssociationAction | null);
    localeSetting?: (proto.SyncActionValue.ILocaleSetting | null);
    archiveChatAction?: (proto.SyncActionValue.IArchiveChatAction | null);
    deleteMessageForMeAction?: (proto.SyncActionValue.IDeleteMessageForMeAction | null);
    keyExpiration?: (proto.SyncActionValue.IKeyExpiration | null);
    markChatAsReadAction?: (proto.SyncActionValue.IMarkChatAsReadAction | null);
    clearChatAction?: (proto.SyncActionValue.IClearChatAction | null);
    deleteChatAction?: (proto.SyncActionValue.IDeleteChatAction | null);
    unarchiveChatsSetting?: (proto.SyncActionValue.IUnarchiveChatsSetting | null);
    primaryFeature?: (proto.SyncActionValue.IPrimaryFeature | null);
    androidUnsupportedActions?: (proto.SyncActionValue.IAndroidUnsupportedActions | null);
    agentAction?: (proto.SyncActionValue.IAgentAction | null);
    subscriptionAction?: (proto.SyncActionValue.ISubscriptionAction | null);
    userStatusMuteAction?: (proto.SyncActionValue.IUserStatusMuteAction | null);
    timeFormatAction?: (proto.SyncActionValue.ITimeFormatAction | null);
    nuxAction?: (proto.SyncActionValue.INuxAction | null);
    primaryVersionAction?: (proto.SyncActionValue.IPrimaryVersionAction | null);
    stickerAction?: (proto.SyncActionValue.IStickerAction | null);
    removeRecentStickerAction?: (proto.SyncActionValue.IRemoveRecentStickerAction | null);
    chatAssignment?: (proto.SyncActionValue.IChatAssignmentAction | null);
    chatAssignmentOpenedStatus?: (proto.SyncActionValue.IChatAssignmentOpenedStatusAction | null);
    pnForLidChatAction?: (proto.SyncActionValue.IPnForLidChatAction | null);
    marketingMessageAction?: (proto.SyncActionValue.IMarketingMessageAction | null);
    marketingMessageBroadcastAction?: (proto.SyncActionValue.IMarketingMessageBroadcastAction | null);
    externalWebBetaAction?: (proto.SyncActionValue.IExternalWebBetaAction | null);
    privacySettingRelayAllCalls?: (proto.SyncActionValue.IPrivacySettingRelayAllCalls | null);
    callLogAction?: (proto.SyncActionValue.ICallLogAction | null);
    ugcBot?: (proto.SyncActionValue.IUGCBot | null);
    statusPrivacy?: (proto.SyncActionValue.IStatusPrivacyAction | null);
    botWelcomeRequestAction?: (proto.SyncActionValue.IBotWelcomeRequestAction | null);
    deleteIndividualCallLog?: (proto.SyncActionValue.IDeleteIndividualCallLogAction | null);
    labelReorderingAction?: (proto.SyncActionValue.ILabelReorderingAction | null);
    paymentInfoAction?: (proto.SyncActionValue.IPaymentInfoAction | null);
    customPaymentMethodsAction?: (proto.SyncActionValue.ICustomPaymentMethodsAction | null);
    lockChatAction?: (proto.SyncActionValue.ILockChatAction | null);
    chatLockSettings?: (proto.IChatLockSettings | null);
    wamoUserIdentifierAction?: (proto.SyncActionValue.IWamoUserIdentifierAction | null);
    privacySettingDisableLinkPreviewsAction?: (proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction | null);
    deviceCapabilities?: (proto.IDeviceCapabilities | null);
    noteEditAction?: (proto.SyncActionValue.INoteEditAction | null);
    favoritesAction?: (proto.SyncActionValue.IFavoritesAction | null);
    merchantPaymentPartnerAction?: (proto.SyncActionValue.IMerchantPaymentPartnerAction | null);
    waffleAccountLinkStateAction?: (proto.SyncActionValue.IWaffleAccountLinkStateAction | null);
    usernameChatStartMode?: (proto.SyncActionValue.IUsernameChatStartModeAction | null);
    notificationActivitySettingAction?: (proto.SyncActionValue.INotificationActivitySettingAction | null);
    lidContactAction?: (proto.SyncActionValue.ILidContactAction | null);
    ctwaPerCustomerDataSharingAction?: (proto.SyncActionValue.ICtwaPerCustomerDataSharingAction | null);
    paymentTosAction?: (proto.SyncActionValue.IPaymentTosAction | null);
    privacySettingChannelsPersonalisedRecommendationAction?: (proto.SyncActionValue.IPrivacySettingChannelsPersonalisedRecommendationAction | null);
    businessBroadcastAssociationAction?: (proto.SyncActionValue.IBusinessBroadcastAssociationAction | null);
    detectedOutcomesStatusAction?: (proto.SyncActionValue.IDetectedOutcomesStatusAction | null);
    maibaAiFeaturesControlAction?: (proto.SyncActionValue.IMaibaAIFeaturesControlAction | null);
    businessBroadcastListAction?: (proto.SyncActionValue.IBusinessBroadcastListAction | null);
    musicUserIdAction?: (proto.SyncActionValue.IMusicUserIdAction | null);
    statusPostOptInNotificationPreferencesAction?: (proto.SyncActionValue.IStatusPostOptInNotificationPreferencesAction | null);
    avatarUpdatedAction?: (proto.SyncActionValue.IAvatarUpdatedAction | null);
    privateProcessingSettingAction?: (proto.SyncActionValue.IPrivateProcessingSettingAction | null);
    newsletterSavedInterestsAction?: (proto.SyncActionValue.INewsletterSavedInterestsAction | null);
    aiThreadRenameAction?: (proto.SyncActionValue.IAiThreadRenameAction | null);
    interactiveMessageAction?: (proto.SyncActionValue.IInteractiveMessageAction | null);
  }
  class SyncActionValue implements ISyncActionValue {
    constructor(p?: proto.ISyncActionValue);
    public timestamp?: (number | Long$1 | null);
    public starAction?: (proto.SyncActionValue.IStarAction | null);
    public contactAction?: (proto.SyncActionValue.IContactAction | null);
    public muteAction?: (proto.SyncActionValue.IMuteAction | null);
    public pinAction?: (proto.SyncActionValue.IPinAction | null);
    public pushNameSetting?: (proto.SyncActionValue.IPushNameSetting | null);
    public quickReplyAction?: (proto.SyncActionValue.IQuickReplyAction | null);
    public recentEmojiWeightsAction?: (proto.SyncActionValue.IRecentEmojiWeightsAction | null);
    public labelEditAction?: (proto.SyncActionValue.ILabelEditAction | null);
    public labelAssociationAction?: (proto.SyncActionValue.ILabelAssociationAction | null);
    public localeSetting?: (proto.SyncActionValue.ILocaleSetting | null);
    public archiveChatAction?: (proto.SyncActionValue.IArchiveChatAction | null);
    public deleteMessageForMeAction?: (proto.SyncActionValue.IDeleteMessageForMeAction | null);
    public keyExpiration?: (proto.SyncActionValue.IKeyExpiration | null);
    public markChatAsReadAction?: (proto.SyncActionValue.IMarkChatAsReadAction | null);
    public clearChatAction?: (proto.SyncActionValue.IClearChatAction | null);
    public deleteChatAction?: (proto.SyncActionValue.IDeleteChatAction | null);
    public unarchiveChatsSetting?: (proto.SyncActionValue.IUnarchiveChatsSetting | null);
    public primaryFeature?: (proto.SyncActionValue.IPrimaryFeature | null);
    public androidUnsupportedActions?: (proto.SyncActionValue.IAndroidUnsupportedActions | null);
    public agentAction?: (proto.SyncActionValue.IAgentAction | null);
    public subscriptionAction?: (proto.SyncActionValue.ISubscriptionAction | null);
    public userStatusMuteAction?: (proto.SyncActionValue.IUserStatusMuteAction | null);
    public timeFormatAction?: (proto.SyncActionValue.ITimeFormatAction | null);
    public nuxAction?: (proto.SyncActionValue.INuxAction | null);
    public primaryVersionAction?: (proto.SyncActionValue.IPrimaryVersionAction | null);
    public stickerAction?: (proto.SyncActionValue.IStickerAction | null);
    public removeRecentStickerAction?: (proto.SyncActionValue.IRemoveRecentStickerAction | null);
    public chatAssignment?: (proto.SyncActionValue.IChatAssignmentAction | null);
    public chatAssignmentOpenedStatus?: (proto.SyncActionValue.IChatAssignmentOpenedStatusAction | null);
    public pnForLidChatAction?: (proto.SyncActionValue.IPnForLidChatAction | null);
    public marketingMessageAction?: (proto.SyncActionValue.IMarketingMessageAction | null);
    public marketingMessageBroadcastAction?: (proto.SyncActionValue.IMarketingMessageBroadcastAction | null);
    public externalWebBetaAction?: (proto.SyncActionValue.IExternalWebBetaAction | null);
    public privacySettingRelayAllCalls?: (proto.SyncActionValue.IPrivacySettingRelayAllCalls | null);
    public callLogAction?: (proto.SyncActionValue.ICallLogAction | null);
    public ugcBot?: (proto.SyncActionValue.IUGCBot | null);
    public statusPrivacy?: (proto.SyncActionValue.IStatusPrivacyAction | null);
    public botWelcomeRequestAction?: (proto.SyncActionValue.IBotWelcomeRequestAction | null);
    public deleteIndividualCallLog?: (proto.SyncActionValue.IDeleteIndividualCallLogAction | null);
    public labelReorderingAction?: (proto.SyncActionValue.ILabelReorderingAction | null);
    public paymentInfoAction?: (proto.SyncActionValue.IPaymentInfoAction | null);
    public customPaymentMethodsAction?: (proto.SyncActionValue.ICustomPaymentMethodsAction | null);
    public lockChatAction?: (proto.SyncActionValue.ILockChatAction | null);
    public chatLockSettings?: (proto.IChatLockSettings | null);
    public wamoUserIdentifierAction?: (proto.SyncActionValue.IWamoUserIdentifierAction | null);
    public privacySettingDisableLinkPreviewsAction?: (proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction | null);
    public deviceCapabilities?: (proto.IDeviceCapabilities | null);
    public noteEditAction?: (proto.SyncActionValue.INoteEditAction | null);
    public favoritesAction?: (proto.SyncActionValue.IFavoritesAction | null);
    public merchantPaymentPartnerAction?: (proto.SyncActionValue.IMerchantPaymentPartnerAction | null);
    public waffleAccountLinkStateAction?: (proto.SyncActionValue.IWaffleAccountLinkStateAction | null);
    public usernameChatStartMode?: (proto.SyncActionValue.IUsernameChatStartModeAction | null);
    public notificationActivitySettingAction?: (proto.SyncActionValue.INotificationActivitySettingAction | null);
    public lidContactAction?: (proto.SyncActionValue.ILidContactAction | null);
    public ctwaPerCustomerDataSharingAction?: (proto.SyncActionValue.ICtwaPerCustomerDataSharingAction | null);
    public paymentTosAction?: (proto.SyncActionValue.IPaymentTosAction | null);
    public privacySettingChannelsPersonalisedRecommendationAction?: (proto.SyncActionValue.IPrivacySettingChannelsPersonalisedRecommendationAction | null);
    public businessBroadcastAssociationAction?: (proto.SyncActionValue.IBusinessBroadcastAssociationAction | null);
    public detectedOutcomesStatusAction?: (proto.SyncActionValue.IDetectedOutcomesStatusAction | null);
    public maibaAiFeaturesControlAction?: (proto.SyncActionValue.IMaibaAIFeaturesControlAction | null);
    public businessBroadcastListAction?: (proto.SyncActionValue.IBusinessBroadcastListAction | null);
    public musicUserIdAction?: (proto.SyncActionValue.IMusicUserIdAction | null);
    public statusPostOptInNotificationPreferencesAction?: (proto.SyncActionValue.IStatusPostOptInNotificationPreferencesAction | null);
    public avatarUpdatedAction?: (proto.SyncActionValue.IAvatarUpdatedAction | null);
    public privateProcessingSettingAction?: (proto.SyncActionValue.IPrivateProcessingSettingAction | null);
    public newsletterSavedInterestsAction?: (proto.SyncActionValue.INewsletterSavedInterestsAction | null);
    public aiThreadRenameAction?: (proto.SyncActionValue.IAiThreadRenameAction | null);
    public interactiveMessageAction?: (proto.SyncActionValue.IInteractiveMessageAction | null);
    public static create(properties?: proto.ISyncActionValue): proto.SyncActionValue;
    public static encode(m: proto.ISyncActionValue, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SyncActionValue;
    public static toObject(m: proto.SyncActionValue, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace SyncActionValue {
    interface IAgentAction {
      name?: (string | null);
      deviceID?: (number | null);
      isDeleted?: (boolean | null);
    }
    class AgentAction implements IAgentAction {
      constructor(p?: proto.SyncActionValue.IAgentAction);
      public name?: (string | null);
      public deviceID?: (number | null);
      public isDeleted?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IAgentAction): proto.SyncActionValue.AgentAction;
      public static encode(m: proto.SyncActionValue.IAgentAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.AgentAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.AgentAction;
      public static toObject(m: proto.SyncActionValue.AgentAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAiThreadRenameAction {
      newTitle?: (string | null);
    }
    class AiThreadRenameAction implements IAiThreadRenameAction {
      constructor(p?: proto.SyncActionValue.IAiThreadRenameAction);
      public newTitle?: (string | null);
      public static create(properties?: proto.SyncActionValue.IAiThreadRenameAction): proto.SyncActionValue.AiThreadRenameAction;
      public static encode(m: proto.SyncActionValue.IAiThreadRenameAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.AiThreadRenameAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.AiThreadRenameAction;
      public static toObject(m: proto.SyncActionValue.AiThreadRenameAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAndroidUnsupportedActions {
      allowed?: (boolean | null);
    }
    class AndroidUnsupportedActions implements IAndroidUnsupportedActions {
      constructor(p?: proto.SyncActionValue.IAndroidUnsupportedActions);
      public allowed?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IAndroidUnsupportedActions): proto.SyncActionValue.AndroidUnsupportedActions;
      public static encode(m: proto.SyncActionValue.IAndroidUnsupportedActions, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.AndroidUnsupportedActions;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.AndroidUnsupportedActions;
      public static toObject(m: proto.SyncActionValue.AndroidUnsupportedActions, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IArchiveChatAction {
      archived?: (boolean | null);
      messageRange?: (proto.SyncActionValue.ISyncActionMessageRange | null);
    }
    class ArchiveChatAction implements IArchiveChatAction {
      constructor(p?: proto.SyncActionValue.IArchiveChatAction);
      public archived?: (boolean | null);
      public messageRange?: (proto.SyncActionValue.ISyncActionMessageRange | null);
      public static create(properties?: proto.SyncActionValue.IArchiveChatAction): proto.SyncActionValue.ArchiveChatAction;
      public static encode(m: proto.SyncActionValue.IArchiveChatAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.ArchiveChatAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.ArchiveChatAction;
      public static toObject(m: proto.SyncActionValue.ArchiveChatAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IAvatarUpdatedAction {
      eventType?: (proto.SyncActionValue.AvatarUpdatedAction.AvatarEventType | null);
      recentAvatarStickers?: (proto.SyncActionValue.IStickerAction[] | null);
    }
    class AvatarUpdatedAction implements IAvatarUpdatedAction {
      constructor(p?: proto.SyncActionValue.IAvatarUpdatedAction);
      public eventType?: (proto.SyncActionValue.AvatarUpdatedAction.AvatarEventType | null);
      public recentAvatarStickers: proto.SyncActionValue.IStickerAction[];
      public static create(properties?: proto.SyncActionValue.IAvatarUpdatedAction): proto.SyncActionValue.AvatarUpdatedAction;
      public static encode(m: proto.SyncActionValue.IAvatarUpdatedAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.AvatarUpdatedAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.AvatarUpdatedAction;
      public static toObject(m: proto.SyncActionValue.AvatarUpdatedAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace AvatarUpdatedAction {
      enum AvatarEventType {
        UPDATED = 0,
        CREATED = 1,
        DELETED = 2
      }
    }
    interface IBotWelcomeRequestAction {
      isSent?: (boolean | null);
    }
    class BotWelcomeRequestAction implements IBotWelcomeRequestAction {
      constructor(p?: proto.SyncActionValue.IBotWelcomeRequestAction);
      public isSent?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IBotWelcomeRequestAction): proto.SyncActionValue.BotWelcomeRequestAction;
      public static encode(m: proto.SyncActionValue.IBotWelcomeRequestAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.BotWelcomeRequestAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.BotWelcomeRequestAction;
      public static toObject(m: proto.SyncActionValue.BotWelcomeRequestAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IBroadcastListParticipant {
      lidJid?: (string | null);
      pnJid?: (string | null);
    }
    class BroadcastListParticipant implements IBroadcastListParticipant {
      constructor(p?: proto.SyncActionValue.IBroadcastListParticipant);
      public lidJid: string;
      public pnJid?: (string | null);
      public static create(properties?: proto.SyncActionValue.IBroadcastListParticipant): proto.SyncActionValue.BroadcastListParticipant;
      public static encode(m: proto.SyncActionValue.IBroadcastListParticipant, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.BroadcastListParticipant;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.BroadcastListParticipant;
      public static toObject(m: proto.SyncActionValue.BroadcastListParticipant, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IBusinessBroadcastAssociationAction {
      deleted?: (boolean | null);
    }
    class BusinessBroadcastAssociationAction implements IBusinessBroadcastAssociationAction {
      constructor(p?: proto.SyncActionValue.IBusinessBroadcastAssociationAction);
      public deleted?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IBusinessBroadcastAssociationAction): proto.SyncActionValue.BusinessBroadcastAssociationAction;
      public static encode(m: proto.SyncActionValue.IBusinessBroadcastAssociationAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.BusinessBroadcastAssociationAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.BusinessBroadcastAssociationAction;
      public static toObject(m: proto.SyncActionValue.BusinessBroadcastAssociationAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IBusinessBroadcastListAction {
      deleted?: (boolean | null);
      participants?: (proto.SyncActionValue.IBroadcastListParticipant[] | null);
      listName?: (string | null);
    }
    class BusinessBroadcastListAction implements IBusinessBroadcastListAction {
      constructor(p?: proto.SyncActionValue.IBusinessBroadcastListAction);
      public deleted?: (boolean | null);
      public participants: proto.SyncActionValue.IBroadcastListParticipant[];
      public listName?: (string | null);
      public static create(properties?: proto.SyncActionValue.IBusinessBroadcastListAction): proto.SyncActionValue.BusinessBroadcastListAction;
      public static encode(m: proto.SyncActionValue.IBusinessBroadcastListAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.BusinessBroadcastListAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.BusinessBroadcastListAction;
      public static toObject(m: proto.SyncActionValue.BusinessBroadcastListAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ICallLogAction {
      callLogRecord?: (proto.ICallLogRecord | null);
    }
    class CallLogAction implements ICallLogAction {
      constructor(p?: proto.SyncActionValue.ICallLogAction);
      public callLogRecord?: (proto.ICallLogRecord | null);
      public static create(properties?: proto.SyncActionValue.ICallLogAction): proto.SyncActionValue.CallLogAction;
      public static encode(m: proto.SyncActionValue.ICallLogAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.CallLogAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.CallLogAction;
      public static toObject(m: proto.SyncActionValue.CallLogAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IChatAssignmentAction {
      deviceAgentID?: (string | null);
    }
    class ChatAssignmentAction implements IChatAssignmentAction {
      constructor(p?: proto.SyncActionValue.IChatAssignmentAction);
      public deviceAgentID?: (string | null);
      public static create(properties?: proto.SyncActionValue.IChatAssignmentAction): proto.SyncActionValue.ChatAssignmentAction;
      public static encode(m: proto.SyncActionValue.IChatAssignmentAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.ChatAssignmentAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.ChatAssignmentAction;
      public static toObject(m: proto.SyncActionValue.ChatAssignmentAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IChatAssignmentOpenedStatusAction {
      chatOpened?: (boolean | null);
    }
    class ChatAssignmentOpenedStatusAction implements IChatAssignmentOpenedStatusAction {
      constructor(p?: proto.SyncActionValue.IChatAssignmentOpenedStatusAction);
      public chatOpened?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IChatAssignmentOpenedStatusAction): proto.SyncActionValue.ChatAssignmentOpenedStatusAction;
      public static encode(m: proto.SyncActionValue.IChatAssignmentOpenedStatusAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.ChatAssignmentOpenedStatusAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.ChatAssignmentOpenedStatusAction;
      public static toObject(m: proto.SyncActionValue.ChatAssignmentOpenedStatusAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IClearChatAction {
      messageRange?: (proto.SyncActionValue.ISyncActionMessageRange | null);
    }
    class ClearChatAction implements IClearChatAction {
      constructor(p?: proto.SyncActionValue.IClearChatAction);
      public messageRange?: (proto.SyncActionValue.ISyncActionMessageRange | null);
      public static create(properties?: proto.SyncActionValue.IClearChatAction): proto.SyncActionValue.ClearChatAction;
      public static encode(m: proto.SyncActionValue.IClearChatAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.ClearChatAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.ClearChatAction;
      public static toObject(m: proto.SyncActionValue.ClearChatAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IContactAction {
      fullName?: (string | null);
      firstName?: (string | null);
      lidJid?: (string | null);
      saveOnPrimaryAddressbook?: (boolean | null);
      pnJid?: (string | null);
      username?: (string | null);
    }
    class ContactAction implements IContactAction {
      constructor(p?: proto.SyncActionValue.IContactAction);
      public fullName?: (string | null);
      public firstName?: (string | null);
      public lidJid?: (string | null);
      public saveOnPrimaryAddressbook?: (boolean | null);
      public pnJid?: (string | null);
      public username?: (string | null);
      public static create(properties?: proto.SyncActionValue.IContactAction): proto.SyncActionValue.ContactAction;
      public static encode(m: proto.SyncActionValue.IContactAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.ContactAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.ContactAction;
      public static toObject(m: proto.SyncActionValue.ContactAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ICtwaPerCustomerDataSharingAction {
      isCtwaPerCustomerDataSharingEnabled?: (boolean | null);
    }
    class CtwaPerCustomerDataSharingAction implements ICtwaPerCustomerDataSharingAction {
      constructor(p?: proto.SyncActionValue.ICtwaPerCustomerDataSharingAction);
      public isCtwaPerCustomerDataSharingEnabled?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.ICtwaPerCustomerDataSharingAction): proto.SyncActionValue.CtwaPerCustomerDataSharingAction;
      public static encode(m: proto.SyncActionValue.ICtwaPerCustomerDataSharingAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.CtwaPerCustomerDataSharingAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.CtwaPerCustomerDataSharingAction;
      public static toObject(m: proto.SyncActionValue.CtwaPerCustomerDataSharingAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ICustomPaymentMethod {
      credentialId?: (string | null);
      country?: (string | null);
      type?: (string | null);
      metadata?: (proto.SyncActionValue.ICustomPaymentMethodMetadata[] | null);
    }
    class CustomPaymentMethod implements ICustomPaymentMethod {
      constructor(p?: proto.SyncActionValue.ICustomPaymentMethod);
      public credentialId: string;
      public country: string;
      public type: string;
      public metadata: proto.SyncActionValue.ICustomPaymentMethodMetadata[];
      public static create(properties?: proto.SyncActionValue.ICustomPaymentMethod): proto.SyncActionValue.CustomPaymentMethod;
      public static encode(m: proto.SyncActionValue.ICustomPaymentMethod, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.CustomPaymentMethod;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.CustomPaymentMethod;
      public static toObject(m: proto.SyncActionValue.CustomPaymentMethod, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ICustomPaymentMethodMetadata {
      key?: (string | null);
      value?: (string | null);
    }
    class CustomPaymentMethodMetadata implements ICustomPaymentMethodMetadata {
      constructor(p?: proto.SyncActionValue.ICustomPaymentMethodMetadata);
      public key: string;
      public value: string;
      public static create(properties?: proto.SyncActionValue.ICustomPaymentMethodMetadata): proto.SyncActionValue.CustomPaymentMethodMetadata;
      public static encode(m: proto.SyncActionValue.ICustomPaymentMethodMetadata, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.CustomPaymentMethodMetadata;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.CustomPaymentMethodMetadata;
      public static toObject(m: proto.SyncActionValue.CustomPaymentMethodMetadata, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ICustomPaymentMethodsAction {
      customPaymentMethods?: (proto.SyncActionValue.ICustomPaymentMethod[] | null);
    }
    class CustomPaymentMethodsAction implements ICustomPaymentMethodsAction {
      constructor(p?: proto.SyncActionValue.ICustomPaymentMethodsAction);
      public customPaymentMethods: proto.SyncActionValue.ICustomPaymentMethod[];
      public static create(properties?: proto.SyncActionValue.ICustomPaymentMethodsAction): proto.SyncActionValue.CustomPaymentMethodsAction;
      public static encode(m: proto.SyncActionValue.ICustomPaymentMethodsAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.CustomPaymentMethodsAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.CustomPaymentMethodsAction;
      public static toObject(m: proto.SyncActionValue.CustomPaymentMethodsAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IDeleteChatAction {
      messageRange?: (proto.SyncActionValue.ISyncActionMessageRange | null);
    }
    class DeleteChatAction implements IDeleteChatAction {
      constructor(p?: proto.SyncActionValue.IDeleteChatAction);
      public messageRange?: (proto.SyncActionValue.ISyncActionMessageRange | null);
      public static create(properties?: proto.SyncActionValue.IDeleteChatAction): proto.SyncActionValue.DeleteChatAction;
      public static encode(m: proto.SyncActionValue.IDeleteChatAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.DeleteChatAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.DeleteChatAction;
      public static toObject(m: proto.SyncActionValue.DeleteChatAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IDeleteIndividualCallLogAction {
      peerJid?: (string | null);
      isIncoming?: (boolean | null);
    }
    class DeleteIndividualCallLogAction implements IDeleteIndividualCallLogAction {
      constructor(p?: proto.SyncActionValue.IDeleteIndividualCallLogAction);
      public peerJid?: (string | null);
      public isIncoming?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IDeleteIndividualCallLogAction): proto.SyncActionValue.DeleteIndividualCallLogAction;
      public static encode(m: proto.SyncActionValue.IDeleteIndividualCallLogAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.DeleteIndividualCallLogAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.DeleteIndividualCallLogAction;
      public static toObject(m: proto.SyncActionValue.DeleteIndividualCallLogAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IDeleteMessageForMeAction {
      deleteMedia?: (boolean | null);
      messageTimestamp?: (number | Long$1 | null);
    }
    class DeleteMessageForMeAction implements IDeleteMessageForMeAction {
      constructor(p?: proto.SyncActionValue.IDeleteMessageForMeAction);
      public deleteMedia?: (boolean | null);
      public messageTimestamp?: (number | Long$1 | null);
      public static create(properties?: proto.SyncActionValue.IDeleteMessageForMeAction): proto.SyncActionValue.DeleteMessageForMeAction;
      public static encode(m: proto.SyncActionValue.IDeleteMessageForMeAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.DeleteMessageForMeAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.DeleteMessageForMeAction;
      public static toObject(m: proto.SyncActionValue.DeleteMessageForMeAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IDetectedOutcomesStatusAction {
      isEnabled?: (boolean | null);
    }
    class DetectedOutcomesStatusAction implements IDetectedOutcomesStatusAction {
      constructor(p?: proto.SyncActionValue.IDetectedOutcomesStatusAction);
      public isEnabled?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IDetectedOutcomesStatusAction): proto.SyncActionValue.DetectedOutcomesStatusAction;
      public static encode(m: proto.SyncActionValue.IDetectedOutcomesStatusAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.DetectedOutcomesStatusAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.DetectedOutcomesStatusAction;
      public static toObject(m: proto.SyncActionValue.DetectedOutcomesStatusAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IExternalWebBetaAction {
      isOptIn?: (boolean | null);
    }
    class ExternalWebBetaAction implements IExternalWebBetaAction {
      constructor(p?: proto.SyncActionValue.IExternalWebBetaAction);
      public isOptIn?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IExternalWebBetaAction): proto.SyncActionValue.ExternalWebBetaAction;
      public static encode(m: proto.SyncActionValue.IExternalWebBetaAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.ExternalWebBetaAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.ExternalWebBetaAction;
      public static toObject(m: proto.SyncActionValue.ExternalWebBetaAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IFavoritesAction {
      favorites?: (proto.SyncActionValue.FavoritesAction.IFavorite[] | null);
    }
    class FavoritesAction implements IFavoritesAction {
      constructor(p?: proto.SyncActionValue.IFavoritesAction);
      public favorites: proto.SyncActionValue.FavoritesAction.IFavorite[];
      public static create(properties?: proto.SyncActionValue.IFavoritesAction): proto.SyncActionValue.FavoritesAction;
      public static encode(m: proto.SyncActionValue.IFavoritesAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.FavoritesAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.FavoritesAction;
      public static toObject(m: proto.SyncActionValue.FavoritesAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace FavoritesAction {
      interface IFavorite {
        id?: (string | null);
      }
      class Favorite implements IFavorite {
        constructor(p?: proto.SyncActionValue.FavoritesAction.IFavorite);
        public id?: (string | null);
        public static create(properties?: proto.SyncActionValue.FavoritesAction.IFavorite): proto.SyncActionValue.FavoritesAction.Favorite;
        public static encode(m: proto.SyncActionValue.FavoritesAction.IFavorite, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.FavoritesAction.Favorite;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.SyncActionValue.FavoritesAction.Favorite;
        public static toObject(m: proto.SyncActionValue.FavoritesAction.Favorite, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
    interface IInteractiveMessageAction {
      type?: (proto.SyncActionValue.InteractiveMessageAction.InteractiveMessageActionMode | null);
    }
    class InteractiveMessageAction implements IInteractiveMessageAction {
      constructor(p?: proto.SyncActionValue.IInteractiveMessageAction);
      public type: proto.SyncActionValue.InteractiveMessageAction.InteractiveMessageActionMode;
      public static create(properties?: proto.SyncActionValue.IInteractiveMessageAction): proto.SyncActionValue.InteractiveMessageAction;
      public static encode(m: proto.SyncActionValue.IInteractiveMessageAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.InteractiveMessageAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.InteractiveMessageAction;
      public static toObject(m: proto.SyncActionValue.InteractiveMessageAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace InteractiveMessageAction {
      enum InteractiveMessageActionMode {
        DISABLE_CTA = 1
      }
    }
    interface IKeyExpiration {
      expiredKeyEpoch?: (number | null);
    }
    class KeyExpiration implements IKeyExpiration {
      constructor(p?: proto.SyncActionValue.IKeyExpiration);
      public expiredKeyEpoch?: (number | null);
      public static create(properties?: proto.SyncActionValue.IKeyExpiration): proto.SyncActionValue.KeyExpiration;
      public static encode(m: proto.SyncActionValue.IKeyExpiration, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.KeyExpiration;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.KeyExpiration;
      public static toObject(m: proto.SyncActionValue.KeyExpiration, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ILabelAssociationAction {
      labeled?: (boolean | null);
    }
    class LabelAssociationAction implements ILabelAssociationAction {
      constructor(p?: proto.SyncActionValue.ILabelAssociationAction);
      public labeled?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.ILabelAssociationAction): proto.SyncActionValue.LabelAssociationAction;
      public static encode(m: proto.SyncActionValue.ILabelAssociationAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.LabelAssociationAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.LabelAssociationAction;
      public static toObject(m: proto.SyncActionValue.LabelAssociationAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ILabelEditAction {
      name?: (string | null);
      color?: (number | null);
      predefinedId?: (number | null);
      deleted?: (boolean | null);
      orderIndex?: (number | null);
      isActive?: (boolean | null);
      type?: (proto.SyncActionValue.LabelEditAction.ListType | null);
      isImmutable?: (boolean | null);
      muteEndTimeMs?: (number | Long$1 | null);
    }
    class LabelEditAction implements ILabelEditAction {
      constructor(p?: proto.SyncActionValue.ILabelEditAction);
      public name?: (string | null);
      public color?: (number | null);
      public predefinedId?: (number | null);
      public deleted?: (boolean | null);
      public orderIndex?: (number | null);
      public isActive?: (boolean | null);
      public type?: (proto.SyncActionValue.LabelEditAction.ListType | null);
      public isImmutable?: (boolean | null);
      public muteEndTimeMs?: (number | Long$1 | null);
      public static create(properties?: proto.SyncActionValue.ILabelEditAction): proto.SyncActionValue.LabelEditAction;
      public static encode(m: proto.SyncActionValue.ILabelEditAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.LabelEditAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.LabelEditAction;
      public static toObject(m: proto.SyncActionValue.LabelEditAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace LabelEditAction {
      enum ListType {
        NONE = 0,
        UNREAD = 1,
        GROUPS = 2,
        FAVORITES = 3,
        PREDEFINED = 4,
        CUSTOM = 5,
        COMMUNITY = 6,
        SERVER_ASSIGNED = 7,
        DRAFTED = 8,
        AI_HANDOFF = 9
      }
    }
    interface ILabelReorderingAction {
      sortedLabelIds?: (number[] | null);
    }
    class LabelReorderingAction implements ILabelReorderingAction {
      constructor(p?: proto.SyncActionValue.ILabelReorderingAction);
      public sortedLabelIds: number[];
      public static create(properties?: proto.SyncActionValue.ILabelReorderingAction): proto.SyncActionValue.LabelReorderingAction;
      public static encode(m: proto.SyncActionValue.ILabelReorderingAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.LabelReorderingAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.LabelReorderingAction;
      public static toObject(m: proto.SyncActionValue.LabelReorderingAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ILidContactAction {
      fullName?: (string | null);
      firstName?: (string | null);
      username?: (string | null);
    }
    class LidContactAction implements ILidContactAction {
      constructor(p?: proto.SyncActionValue.ILidContactAction);
      public fullName?: (string | null);
      public firstName?: (string | null);
      public username?: (string | null);
      public static create(properties?: proto.SyncActionValue.ILidContactAction): proto.SyncActionValue.LidContactAction;
      public static encode(m: proto.SyncActionValue.ILidContactAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.LidContactAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.LidContactAction;
      public static toObject(m: proto.SyncActionValue.LidContactAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ILocaleSetting {
      locale?: (string | null);
    }
    class LocaleSetting implements ILocaleSetting {
      constructor(p?: proto.SyncActionValue.ILocaleSetting);
      public locale?: (string | null);
      public static create(properties?: proto.SyncActionValue.ILocaleSetting): proto.SyncActionValue.LocaleSetting;
      public static encode(m: proto.SyncActionValue.ILocaleSetting, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.LocaleSetting;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.LocaleSetting;
      public static toObject(m: proto.SyncActionValue.LocaleSetting, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ILockChatAction {
      locked?: (boolean | null);
    }
    class LockChatAction implements ILockChatAction {
      constructor(p?: proto.SyncActionValue.ILockChatAction);
      public locked?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.ILockChatAction): proto.SyncActionValue.LockChatAction;
      public static encode(m: proto.SyncActionValue.ILockChatAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.LockChatAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.LockChatAction;
      public static toObject(m: proto.SyncActionValue.LockChatAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IMaibaAIFeaturesControlAction {
      aiFeatureStatus?: (proto.SyncActionValue.MaibaAIFeaturesControlAction.MaibaAIFeatureStatus | null);
    }
    class MaibaAIFeaturesControlAction implements IMaibaAIFeaturesControlAction {
      constructor(p?: proto.SyncActionValue.IMaibaAIFeaturesControlAction);
      public aiFeatureStatus?: (proto.SyncActionValue.MaibaAIFeaturesControlAction.MaibaAIFeatureStatus | null);
      public static create(properties?: proto.SyncActionValue.IMaibaAIFeaturesControlAction): proto.SyncActionValue.MaibaAIFeaturesControlAction;
      public static encode(m: proto.SyncActionValue.IMaibaAIFeaturesControlAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.MaibaAIFeaturesControlAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.MaibaAIFeaturesControlAction;
      public static toObject(m: proto.SyncActionValue.MaibaAIFeaturesControlAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace MaibaAIFeaturesControlAction {
      enum MaibaAIFeatureStatus {
        ENABLED = 0,
        ENABLED_HAS_LEARNING = 1,
        DISABLED = 2
      }
    }
    interface IMarkChatAsReadAction {
      read?: (boolean | null);
      messageRange?: (proto.SyncActionValue.ISyncActionMessageRange | null);
    }
    class MarkChatAsReadAction implements IMarkChatAsReadAction {
      constructor(p?: proto.SyncActionValue.IMarkChatAsReadAction);
      public read?: (boolean | null);
      public messageRange?: (proto.SyncActionValue.ISyncActionMessageRange | null);
      public static create(properties?: proto.SyncActionValue.IMarkChatAsReadAction): proto.SyncActionValue.MarkChatAsReadAction;
      public static encode(m: proto.SyncActionValue.IMarkChatAsReadAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.MarkChatAsReadAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.MarkChatAsReadAction;
      public static toObject(m: proto.SyncActionValue.MarkChatAsReadAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IMarketingMessageAction {
      name?: (string | null);
      message?: (string | null);
      type?: (proto.SyncActionValue.MarketingMessageAction.MarketingMessagePrototypeType | null);
      createdAt?: (number | Long$1 | null);
      lastSentAt?: (number | Long$1 | null);
      isDeleted?: (boolean | null);
      mediaId?: (string | null);
    }
    class MarketingMessageAction implements IMarketingMessageAction {
      constructor(p?: proto.SyncActionValue.IMarketingMessageAction);
      public name?: (string | null);
      public message?: (string | null);
      public type?: (proto.SyncActionValue.MarketingMessageAction.MarketingMessagePrototypeType | null);
      public createdAt?: (number | Long$1 | null);
      public lastSentAt?: (number | Long$1 | null);
      public isDeleted?: (boolean | null);
      public mediaId?: (string | null);
      public static create(properties?: proto.SyncActionValue.IMarketingMessageAction): proto.SyncActionValue.MarketingMessageAction;
      public static encode(m: proto.SyncActionValue.IMarketingMessageAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.MarketingMessageAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.MarketingMessageAction;
      public static toObject(m: proto.SyncActionValue.MarketingMessageAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace MarketingMessageAction {
      enum MarketingMessagePrototypeType {
        PERSONALIZED = 0
      }
    }
    interface IMarketingMessageBroadcastAction {
      repliedCount?: (number | null);
    }
    class MarketingMessageBroadcastAction implements IMarketingMessageBroadcastAction {
      constructor(p?: proto.SyncActionValue.IMarketingMessageBroadcastAction);
      public repliedCount?: (number | null);
      public static create(properties?: proto.SyncActionValue.IMarketingMessageBroadcastAction): proto.SyncActionValue.MarketingMessageBroadcastAction;
      public static encode(m: proto.SyncActionValue.IMarketingMessageBroadcastAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.MarketingMessageBroadcastAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.MarketingMessageBroadcastAction;
      public static toObject(m: proto.SyncActionValue.MarketingMessageBroadcastAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IMerchantPaymentPartnerAction {
      status?: (proto.SyncActionValue.MerchantPaymentPartnerAction.Status | null);
      country?: (string | null);
      gatewayName?: (string | null);
      credentialId?: (string | null);
    }
    class MerchantPaymentPartnerAction implements IMerchantPaymentPartnerAction {
      constructor(p?: proto.SyncActionValue.IMerchantPaymentPartnerAction);
      public status: proto.SyncActionValue.MerchantPaymentPartnerAction.Status;
      public country: string;
      public gatewayName?: (string | null);
      public credentialId?: (string | null);
      public static create(properties?: proto.SyncActionValue.IMerchantPaymentPartnerAction): proto.SyncActionValue.MerchantPaymentPartnerAction;
      public static encode(m: proto.SyncActionValue.IMerchantPaymentPartnerAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.MerchantPaymentPartnerAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.MerchantPaymentPartnerAction;
      public static toObject(m: proto.SyncActionValue.MerchantPaymentPartnerAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace MerchantPaymentPartnerAction {
      enum Status {
        ACTIVE = 0,
        INACTIVE = 1
      }
    }
    interface IMusicUserIdAction {
      musicUserId?: (string | null);
      musicUserIdMap?: ({
        [k: string]: string;
      } | null);
    }
    class MusicUserIdAction implements IMusicUserIdAction {
      constructor(p?: proto.SyncActionValue.IMusicUserIdAction);
      public musicUserId?: (string | null);
      public musicUserIdMap: {
        [k: string]: string;
      };
      public static create(properties?: proto.SyncActionValue.IMusicUserIdAction): proto.SyncActionValue.MusicUserIdAction;
      public static encode(m: proto.SyncActionValue.IMusicUserIdAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.MusicUserIdAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.MusicUserIdAction;
      public static toObject(m: proto.SyncActionValue.MusicUserIdAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IMuteAction {
      muted?: (boolean | null);
      muteEndTimestamp?: (number | Long$1 | null);
      autoMuted?: (boolean | null);
    }
    class MuteAction implements IMuteAction {
      constructor(p?: proto.SyncActionValue.IMuteAction);
      public muted?: (boolean | null);
      public muteEndTimestamp?: (number | Long$1 | null);
      public autoMuted?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IMuteAction): proto.SyncActionValue.MuteAction;
      public static encode(m: proto.SyncActionValue.IMuteAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.MuteAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.MuteAction;
      public static toObject(m: proto.SyncActionValue.MuteAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface INewsletterSavedInterestsAction {
      newsletterSavedInterests?: (string | null);
    }
    class NewsletterSavedInterestsAction implements INewsletterSavedInterestsAction {
      constructor(p?: proto.SyncActionValue.INewsletterSavedInterestsAction);
      public newsletterSavedInterests?: (string | null);
      public static create(properties?: proto.SyncActionValue.INewsletterSavedInterestsAction): proto.SyncActionValue.NewsletterSavedInterestsAction;
      public static encode(m: proto.SyncActionValue.INewsletterSavedInterestsAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.NewsletterSavedInterestsAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.NewsletterSavedInterestsAction;
      public static toObject(m: proto.SyncActionValue.NewsletterSavedInterestsAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface INoteEditAction {
      type?: (proto.SyncActionValue.NoteEditAction.NoteType | null);
      chatJid?: (string | null);
      createdAt?: (number | Long$1 | null);
      deleted?: (boolean | null);
      unstructuredContent?: (string | null);
    }
    class NoteEditAction implements INoteEditAction {
      constructor(p?: proto.SyncActionValue.INoteEditAction);
      public type?: (proto.SyncActionValue.NoteEditAction.NoteType | null);
      public chatJid?: (string | null);
      public createdAt?: (number | Long$1 | null);
      public deleted?: (boolean | null);
      public unstructuredContent?: (string | null);
      public static create(properties?: proto.SyncActionValue.INoteEditAction): proto.SyncActionValue.NoteEditAction;
      public static encode(m: proto.SyncActionValue.INoteEditAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.NoteEditAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.NoteEditAction;
      public static toObject(m: proto.SyncActionValue.NoteEditAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace NoteEditAction {
      enum NoteType {
        UNSTRUCTURED = 1,
        STRUCTURED = 2
      }
    }
    interface INotificationActivitySettingAction {
      notificationActivitySetting?: (proto.SyncActionValue.NotificationActivitySettingAction.NotificationActivitySetting | null);
    }
    class NotificationActivitySettingAction implements INotificationActivitySettingAction {
      constructor(p?: proto.SyncActionValue.INotificationActivitySettingAction);
      public notificationActivitySetting?: (proto.SyncActionValue.NotificationActivitySettingAction.NotificationActivitySetting | null);
      public static create(properties?: proto.SyncActionValue.INotificationActivitySettingAction): proto.SyncActionValue.NotificationActivitySettingAction;
      public static encode(m: proto.SyncActionValue.INotificationActivitySettingAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.NotificationActivitySettingAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.NotificationActivitySettingAction;
      public static toObject(m: proto.SyncActionValue.NotificationActivitySettingAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace NotificationActivitySettingAction {
      enum NotificationActivitySetting {
        DEFAULT_ALL_MESSAGES = 0,
        ALL_MESSAGES = 1,
        HIGHLIGHTS = 2,
        DEFAULT_HIGHLIGHTS = 3
      }
    }
    interface INuxAction {
      acknowledged?: (boolean | null);
    }
    class NuxAction implements INuxAction {
      constructor(p?: proto.SyncActionValue.INuxAction);
      public acknowledged?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.INuxAction): proto.SyncActionValue.NuxAction;
      public static encode(m: proto.SyncActionValue.INuxAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.NuxAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.NuxAction;
      public static toObject(m: proto.SyncActionValue.NuxAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPaymentInfoAction {
      cpi?: (string | null);
    }
    class PaymentInfoAction implements IPaymentInfoAction {
      constructor(p?: proto.SyncActionValue.IPaymentInfoAction);
      public cpi?: (string | null);
      public static create(properties?: proto.SyncActionValue.IPaymentInfoAction): proto.SyncActionValue.PaymentInfoAction;
      public static encode(m: proto.SyncActionValue.IPaymentInfoAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.PaymentInfoAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.PaymentInfoAction;
      public static toObject(m: proto.SyncActionValue.PaymentInfoAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPaymentTosAction {
      paymentNotice?: (proto.SyncActionValue.PaymentTosAction.PaymentNotice | null);
      accepted?: (boolean | null);
    }
    class PaymentTosAction implements IPaymentTosAction {
      constructor(p?: proto.SyncActionValue.IPaymentTosAction);
      public paymentNotice: proto.SyncActionValue.PaymentTosAction.PaymentNotice;
      public accepted: boolean;
      public static create(properties?: proto.SyncActionValue.IPaymentTosAction): proto.SyncActionValue.PaymentTosAction;
      public static encode(m: proto.SyncActionValue.IPaymentTosAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.PaymentTosAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.PaymentTosAction;
      public static toObject(m: proto.SyncActionValue.PaymentTosAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace PaymentTosAction {
      enum PaymentNotice {
        BR_PAY_PRIVACY_POLICY = 0
      }
    }
    interface IPinAction {
      pinned?: (boolean | null);
    }
    class PinAction implements IPinAction {
      constructor(p?: proto.SyncActionValue.IPinAction);
      public pinned?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IPinAction): proto.SyncActionValue.PinAction;
      public static encode(m: proto.SyncActionValue.IPinAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.PinAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.PinAction;
      public static toObject(m: proto.SyncActionValue.PinAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPnForLidChatAction {
      pnJid?: (string | null);
    }
    class PnForLidChatAction implements IPnForLidChatAction {
      constructor(p?: proto.SyncActionValue.IPnForLidChatAction);
      public pnJid?: (string | null);
      public static create(properties?: proto.SyncActionValue.IPnForLidChatAction): proto.SyncActionValue.PnForLidChatAction;
      public static encode(m: proto.SyncActionValue.IPnForLidChatAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.PnForLidChatAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.PnForLidChatAction;
      public static toObject(m: proto.SyncActionValue.PnForLidChatAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPrimaryFeature {
      flags?: (string[] | null);
    }
    class PrimaryFeature implements IPrimaryFeature {
      constructor(p?: proto.SyncActionValue.IPrimaryFeature);
      public flags: string[];
      public static create(properties?: proto.SyncActionValue.IPrimaryFeature): proto.SyncActionValue.PrimaryFeature;
      public static encode(m: proto.SyncActionValue.IPrimaryFeature, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.PrimaryFeature;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.PrimaryFeature;
      public static toObject(m: proto.SyncActionValue.PrimaryFeature, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPrimaryVersionAction {
      version?: (string | null);
    }
    class PrimaryVersionAction implements IPrimaryVersionAction {
      constructor(p?: proto.SyncActionValue.IPrimaryVersionAction);
      public version?: (string | null);
      public static create(properties?: proto.SyncActionValue.IPrimaryVersionAction): proto.SyncActionValue.PrimaryVersionAction;
      public static encode(m: proto.SyncActionValue.IPrimaryVersionAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.PrimaryVersionAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.PrimaryVersionAction;
      public static toObject(m: proto.SyncActionValue.PrimaryVersionAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPrivacySettingChannelsPersonalisedRecommendationAction {
      isUserOptedOut?: (boolean | null);
    }
    class PrivacySettingChannelsPersonalisedRecommendationAction implements IPrivacySettingChannelsPersonalisedRecommendationAction {
      constructor(p?: proto.SyncActionValue.IPrivacySettingChannelsPersonalisedRecommendationAction);
      public isUserOptedOut?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IPrivacySettingChannelsPersonalisedRecommendationAction): proto.SyncActionValue.PrivacySettingChannelsPersonalisedRecommendationAction;
      public static encode(m: proto.SyncActionValue.IPrivacySettingChannelsPersonalisedRecommendationAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.PrivacySettingChannelsPersonalisedRecommendationAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.PrivacySettingChannelsPersonalisedRecommendationAction;
      public static toObject(m: proto.SyncActionValue.PrivacySettingChannelsPersonalisedRecommendationAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPrivacySettingDisableLinkPreviewsAction {
      isPreviewsDisabled?: (boolean | null);
    }
    class PrivacySettingDisableLinkPreviewsAction implements IPrivacySettingDisableLinkPreviewsAction {
      constructor(p?: proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction);
      public isPreviewsDisabled?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction): proto.SyncActionValue.PrivacySettingDisableLinkPreviewsAction;
      public static encode(m: proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.PrivacySettingDisableLinkPreviewsAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.PrivacySettingDisableLinkPreviewsAction;
      public static toObject(m: proto.SyncActionValue.PrivacySettingDisableLinkPreviewsAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPrivacySettingRelayAllCalls {
      isEnabled?: (boolean | null);
    }
    class PrivacySettingRelayAllCalls implements IPrivacySettingRelayAllCalls {
      constructor(p?: proto.SyncActionValue.IPrivacySettingRelayAllCalls);
      public isEnabled?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IPrivacySettingRelayAllCalls): proto.SyncActionValue.PrivacySettingRelayAllCalls;
      public static encode(m: proto.SyncActionValue.IPrivacySettingRelayAllCalls, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.PrivacySettingRelayAllCalls;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.PrivacySettingRelayAllCalls;
      public static toObject(m: proto.SyncActionValue.PrivacySettingRelayAllCalls, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IPrivateProcessingSettingAction {
      privateProcessingStatus?: (proto.SyncActionValue.PrivateProcessingSettingAction.PrivateProcessingStatus | null);
    }
    class PrivateProcessingSettingAction implements IPrivateProcessingSettingAction {
      constructor(p?: proto.SyncActionValue.IPrivateProcessingSettingAction);
      public privateProcessingStatus?: (proto.SyncActionValue.PrivateProcessingSettingAction.PrivateProcessingStatus | null);
      public static create(properties?: proto.SyncActionValue.IPrivateProcessingSettingAction): proto.SyncActionValue.PrivateProcessingSettingAction;
      public static encode(m: proto.SyncActionValue.IPrivateProcessingSettingAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.PrivateProcessingSettingAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.PrivateProcessingSettingAction;
      public static toObject(m: proto.SyncActionValue.PrivateProcessingSettingAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace PrivateProcessingSettingAction {
      enum PrivateProcessingStatus {
        UNDEFINED = 0,
        ENABLED = 1,
        DISABLED = 2
      }
    }
    interface IPushNameSetting {
      name?: (string | null);
    }
    class PushNameSetting implements IPushNameSetting {
      constructor(p?: proto.SyncActionValue.IPushNameSetting);
      public name?: (string | null);
      public static create(properties?: proto.SyncActionValue.IPushNameSetting): proto.SyncActionValue.PushNameSetting;
      public static encode(m: proto.SyncActionValue.IPushNameSetting, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.PushNameSetting;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.PushNameSetting;
      public static toObject(m: proto.SyncActionValue.PushNameSetting, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IQuickReplyAction {
      shortcut?: (string | null);
      message?: (string | null);
      keywords?: (string[] | null);
      count?: (number | null);
      deleted?: (boolean | null);
    }
    class QuickReplyAction implements IQuickReplyAction {
      constructor(p?: proto.SyncActionValue.IQuickReplyAction);
      public shortcut?: (string | null);
      public message?: (string | null);
      public keywords: string[];
      public count?: (number | null);
      public deleted?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IQuickReplyAction): proto.SyncActionValue.QuickReplyAction;
      public static encode(m: proto.SyncActionValue.IQuickReplyAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.QuickReplyAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.QuickReplyAction;
      public static toObject(m: proto.SyncActionValue.QuickReplyAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IRecentEmojiWeightsAction {
      weights?: (proto.IRecentEmojiWeight[] | null);
    }
    class RecentEmojiWeightsAction implements IRecentEmojiWeightsAction {
      constructor(p?: proto.SyncActionValue.IRecentEmojiWeightsAction);
      public weights: proto.IRecentEmojiWeight[];
      public static create(properties?: proto.SyncActionValue.IRecentEmojiWeightsAction): proto.SyncActionValue.RecentEmojiWeightsAction;
      public static encode(m: proto.SyncActionValue.IRecentEmojiWeightsAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.RecentEmojiWeightsAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.RecentEmojiWeightsAction;
      public static toObject(m: proto.SyncActionValue.RecentEmojiWeightsAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IRemoveRecentStickerAction {
      lastStickerSentTs?: (number | Long$1 | null);
    }
    class RemoveRecentStickerAction implements IRemoveRecentStickerAction {
      constructor(p?: proto.SyncActionValue.IRemoveRecentStickerAction);
      public lastStickerSentTs?: (number | Long$1 | null);
      public static create(properties?: proto.SyncActionValue.IRemoveRecentStickerAction): proto.SyncActionValue.RemoveRecentStickerAction;
      public static encode(m: proto.SyncActionValue.IRemoveRecentStickerAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.RemoveRecentStickerAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.RemoveRecentStickerAction;
      public static toObject(m: proto.SyncActionValue.RemoveRecentStickerAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IStarAction {
      starred?: (boolean | null);
    }
    class StarAction implements IStarAction {
      constructor(p?: proto.SyncActionValue.IStarAction);
      public starred?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IStarAction): proto.SyncActionValue.StarAction;
      public static encode(m: proto.SyncActionValue.IStarAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.StarAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.StarAction;
      public static toObject(m: proto.SyncActionValue.StarAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IStatusPostOptInNotificationPreferencesAction {
      enabled?: (boolean | null);
    }
    class StatusPostOptInNotificationPreferencesAction implements IStatusPostOptInNotificationPreferencesAction {
      constructor(p?: proto.SyncActionValue.IStatusPostOptInNotificationPreferencesAction);
      public enabled?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IStatusPostOptInNotificationPreferencesAction): proto.SyncActionValue.StatusPostOptInNotificationPreferencesAction;
      public static encode(m: proto.SyncActionValue.IStatusPostOptInNotificationPreferencesAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.StatusPostOptInNotificationPreferencesAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.StatusPostOptInNotificationPreferencesAction;
      public static toObject(m: proto.SyncActionValue.StatusPostOptInNotificationPreferencesAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IStatusPrivacyAction {
      mode?: (proto.SyncActionValue.StatusPrivacyAction.StatusDistributionMode | null);
      userJid?: (string[] | null);
    }
    class StatusPrivacyAction implements IStatusPrivacyAction {
      constructor(p?: proto.SyncActionValue.IStatusPrivacyAction);
      public mode?: (proto.SyncActionValue.StatusPrivacyAction.StatusDistributionMode | null);
      public userJid: string[];
      public static create(properties?: proto.SyncActionValue.IStatusPrivacyAction): proto.SyncActionValue.StatusPrivacyAction;
      public static encode(m: proto.SyncActionValue.IStatusPrivacyAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.StatusPrivacyAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.StatusPrivacyAction;
      public static toObject(m: proto.SyncActionValue.StatusPrivacyAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace StatusPrivacyAction {
      enum StatusDistributionMode {
        ALLOW_LIST = 0,
        DENY_LIST = 1,
        CONTACTS = 2,
        CLOSE_FRIENDS = 3
      }
    }
    interface IStickerAction {
      url?: (string | null);
      fileEncSha256?: (Uint8Array | null);
      mediaKey?: (Uint8Array | null);
      mimetype?: (string | null);
      height?: (number | null);
      width?: (number | null);
      directPath?: (string | null);
      fileLength?: (number | Long$1 | null);
      isFavorite?: (boolean | null);
      deviceIdHint?: (number | null);
      isLottie?: (boolean | null);
      imageHash?: (string | null);
      isAvatarSticker?: (boolean | null);
    }
    class StickerAction implements IStickerAction {
      constructor(p?: proto.SyncActionValue.IStickerAction);
      public url?: (string | null);
      public fileEncSha256?: (Uint8Array | null);
      public mediaKey?: (Uint8Array | null);
      public mimetype?: (string | null);
      public height?: (number | null);
      public width?: (number | null);
      public directPath?: (string | null);
      public fileLength?: (number | Long$1 | null);
      public isFavorite?: (boolean | null);
      public deviceIdHint?: (number | null);
      public isLottie?: (boolean | null);
      public imageHash?: (string | null);
      public isAvatarSticker?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IStickerAction): proto.SyncActionValue.StickerAction;
      public static encode(m: proto.SyncActionValue.IStickerAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.StickerAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.StickerAction;
      public static toObject(m: proto.SyncActionValue.StickerAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ISubscriptionAction {
      isDeactivated?: (boolean | null);
      isAutoRenewing?: (boolean | null);
      expirationDate?: (number | Long$1 | null);
    }
    class SubscriptionAction implements ISubscriptionAction {
      constructor(p?: proto.SyncActionValue.ISubscriptionAction);
      public isDeactivated?: (boolean | null);
      public isAutoRenewing?: (boolean | null);
      public expirationDate?: (number | Long$1 | null);
      public static create(properties?: proto.SyncActionValue.ISubscriptionAction): proto.SyncActionValue.SubscriptionAction;
      public static encode(m: proto.SyncActionValue.ISubscriptionAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.SubscriptionAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.SubscriptionAction;
      public static toObject(m: proto.SyncActionValue.SubscriptionAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ISyncActionMessage {
      key?: (proto.IMessageKey | null);
      timestamp?: (number | Long$1 | null);
    }
    class SyncActionMessage implements ISyncActionMessage {
      constructor(p?: proto.SyncActionValue.ISyncActionMessage);
      public key?: (proto.IMessageKey | null);
      public timestamp?: (number | Long$1 | null);
      public static create(properties?: proto.SyncActionValue.ISyncActionMessage): proto.SyncActionValue.SyncActionMessage;
      public static encode(m: proto.SyncActionValue.ISyncActionMessage, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.SyncActionMessage;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.SyncActionMessage;
      public static toObject(m: proto.SyncActionValue.SyncActionMessage, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ISyncActionMessageRange {
      lastMessageTimestamp?: (number | Long$1 | null);
      lastSystemMessageTimestamp?: (number | Long$1 | null);
      messages?: (proto.SyncActionValue.ISyncActionMessage[] | null);
    }
    class SyncActionMessageRange implements ISyncActionMessageRange {
      constructor(p?: proto.SyncActionValue.ISyncActionMessageRange);
      public lastMessageTimestamp?: (number | Long$1 | null);
      public lastSystemMessageTimestamp?: (number | Long$1 | null);
      public messages: proto.SyncActionValue.ISyncActionMessage[];
      public static create(properties?: proto.SyncActionValue.ISyncActionMessageRange): proto.SyncActionValue.SyncActionMessageRange;
      public static encode(m: proto.SyncActionValue.ISyncActionMessageRange, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.SyncActionMessageRange;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.SyncActionMessageRange;
      public static toObject(m: proto.SyncActionValue.SyncActionMessageRange, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface ITimeFormatAction {
      isTwentyFourHourFormatEnabled?: (boolean | null);
    }
    class TimeFormatAction implements ITimeFormatAction {
      constructor(p?: proto.SyncActionValue.ITimeFormatAction);
      public isTwentyFourHourFormatEnabled?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.ITimeFormatAction): proto.SyncActionValue.TimeFormatAction;
      public static encode(m: proto.SyncActionValue.ITimeFormatAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.TimeFormatAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.TimeFormatAction;
      public static toObject(m: proto.SyncActionValue.TimeFormatAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IUGCBot {
      definition?: (Uint8Array | null);
    }
    class UGCBot implements IUGCBot {
      constructor(p?: proto.SyncActionValue.IUGCBot);
      public definition?: (Uint8Array | null);
      public static create(properties?: proto.SyncActionValue.IUGCBot): proto.SyncActionValue.UGCBot;
      public static encode(m: proto.SyncActionValue.IUGCBot, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.UGCBot;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.UGCBot;
      public static toObject(m: proto.SyncActionValue.UGCBot, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IUnarchiveChatsSetting {
      unarchiveChats?: (boolean | null);
    }
    class UnarchiveChatsSetting implements IUnarchiveChatsSetting {
      constructor(p?: proto.SyncActionValue.IUnarchiveChatsSetting);
      public unarchiveChats?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IUnarchiveChatsSetting): proto.SyncActionValue.UnarchiveChatsSetting;
      public static encode(m: proto.SyncActionValue.IUnarchiveChatsSetting, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.UnarchiveChatsSetting;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.UnarchiveChatsSetting;
      public static toObject(m: proto.SyncActionValue.UnarchiveChatsSetting, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IUserStatusMuteAction {
      muted?: (boolean | null);
    }
    class UserStatusMuteAction implements IUserStatusMuteAction {
      constructor(p?: proto.SyncActionValue.IUserStatusMuteAction);
      public muted?: (boolean | null);
      public static create(properties?: proto.SyncActionValue.IUserStatusMuteAction): proto.SyncActionValue.UserStatusMuteAction;
      public static encode(m: proto.SyncActionValue.IUserStatusMuteAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.UserStatusMuteAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.UserStatusMuteAction;
      public static toObject(m: proto.SyncActionValue.UserStatusMuteAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IUsernameChatStartModeAction {
      chatStartMode?: (proto.SyncActionValue.UsernameChatStartModeAction.ChatStartMode | null);
    }
    class UsernameChatStartModeAction implements IUsernameChatStartModeAction {
      constructor(p?: proto.SyncActionValue.IUsernameChatStartModeAction);
      public chatStartMode?: (proto.SyncActionValue.UsernameChatStartModeAction.ChatStartMode | null);
      public static create(properties?: proto.SyncActionValue.IUsernameChatStartModeAction): proto.SyncActionValue.UsernameChatStartModeAction;
      public static encode(m: proto.SyncActionValue.IUsernameChatStartModeAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.UsernameChatStartModeAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.UsernameChatStartModeAction;
      public static toObject(m: proto.SyncActionValue.UsernameChatStartModeAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace UsernameChatStartModeAction {
      enum ChatStartMode {
        LID = 1,
        PN = 2
      }
    }
    interface IWaffleAccountLinkStateAction {
      linkState?: (proto.SyncActionValue.WaffleAccountLinkStateAction.AccountLinkState | null);
    }
    class WaffleAccountLinkStateAction implements IWaffleAccountLinkStateAction {
      constructor(p?: proto.SyncActionValue.IWaffleAccountLinkStateAction);
      public linkState?: (proto.SyncActionValue.WaffleAccountLinkStateAction.AccountLinkState | null);
      public static create(properties?: proto.SyncActionValue.IWaffleAccountLinkStateAction): proto.SyncActionValue.WaffleAccountLinkStateAction;
      public static encode(m: proto.SyncActionValue.IWaffleAccountLinkStateAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.WaffleAccountLinkStateAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.WaffleAccountLinkStateAction;
      public static toObject(m: proto.SyncActionValue.WaffleAccountLinkStateAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace WaffleAccountLinkStateAction {
      enum AccountLinkState {
        ACTIVE = 0,
        PAUSED = 1,
        UNLINKED = 2
      }
    }
    interface IWamoUserIdentifierAction {
      identifier?: (string | null);
    }
    class WamoUserIdentifierAction implements IWamoUserIdentifierAction {
      constructor(p?: proto.SyncActionValue.IWamoUserIdentifierAction);
      public identifier?: (string | null);
      public static create(properties?: proto.SyncActionValue.IWamoUserIdentifierAction): proto.SyncActionValue.WamoUserIdentifierAction;
      public static encode(m: proto.SyncActionValue.IWamoUserIdentifierAction, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncActionValue.WamoUserIdentifierAction;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.SyncActionValue.WamoUserIdentifierAction;
      public static toObject(m: proto.SyncActionValue.WamoUserIdentifierAction, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface ISyncdIndex {
    blob?: (Uint8Array | null);
  }
  class SyncdIndex implements ISyncdIndex {
    constructor(p?: proto.ISyncdIndex);
    public blob?: (Uint8Array | null);
    public static create(properties?: proto.ISyncdIndex): proto.SyncdIndex;
    public static encode(m: proto.ISyncdIndex, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncdIndex;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SyncdIndex;
    public static toObject(m: proto.SyncdIndex, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISyncdMutation {
    operation?: (proto.SyncdMutation.SyncdOperation | null);
    record?: (proto.ISyncdRecord | null);
  }
  class SyncdMutation implements ISyncdMutation {
    constructor(p?: proto.ISyncdMutation);
    public operation?: (proto.SyncdMutation.SyncdOperation | null);
    public record?: (proto.ISyncdRecord | null);
    public static create(properties?: proto.ISyncdMutation): proto.SyncdMutation;
    public static encode(m: proto.ISyncdMutation, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncdMutation;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SyncdMutation;
    public static toObject(m: proto.SyncdMutation, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace SyncdMutation {
    enum SyncdOperation {
      SET = 0,
      REMOVE = 1
    }
  }
  interface ISyncdMutations {
    mutations?: (proto.ISyncdMutation[] | null);
  }
  class SyncdMutations implements ISyncdMutations {
    constructor(p?: proto.ISyncdMutations);
    public mutations: proto.ISyncdMutation[];
    public static create(properties?: proto.ISyncdMutations): proto.SyncdMutations;
    public static encode(m: proto.ISyncdMutations, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncdMutations;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SyncdMutations;
    public static toObject(m: proto.SyncdMutations, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISyncdPatch {
    version?: (proto.ISyncdVersion | null);
    mutations?: (proto.ISyncdMutation[] | null);
    externalMutations?: (proto.IExternalBlobReference | null);
    snapshotMac?: (Uint8Array | null);
    patchMac?: (Uint8Array | null);
    keyId?: (proto.IKeyId | null);
    exitCode?: (proto.IExitCode | null);
    deviceIndex?: (number | null);
    clientDebugData?: (Uint8Array | null);
  }
  class SyncdPatch implements ISyncdPatch {
    constructor(p?: proto.ISyncdPatch);
    public version?: (proto.ISyncdVersion | null);
    public mutations: proto.ISyncdMutation[];
    public externalMutations?: (proto.IExternalBlobReference | null);
    public snapshotMac?: (Uint8Array | null);
    public patchMac?: (Uint8Array | null);
    public keyId?: (proto.IKeyId | null);
    public exitCode?: (proto.IExitCode | null);
    public deviceIndex?: (number | null);
    public clientDebugData?: (Uint8Array | null);
    public static create(properties?: proto.ISyncdPatch): proto.SyncdPatch;
    public static encode(m: proto.ISyncdPatch, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncdPatch;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SyncdPatch;
    public static toObject(m: proto.SyncdPatch, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISyncdRecord {
    index?: (proto.ISyncdIndex | null);
    value?: (proto.ISyncdValue | null);
    keyId?: (proto.IKeyId | null);
  }
  class SyncdRecord implements ISyncdRecord {
    constructor(p?: proto.ISyncdRecord);
    public index?: (proto.ISyncdIndex | null);
    public value?: (proto.ISyncdValue | null);
    public keyId?: (proto.IKeyId | null);
    public static create(properties?: proto.ISyncdRecord): proto.SyncdRecord;
    public static encode(m: proto.ISyncdRecord, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncdRecord;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SyncdRecord;
    public static toObject(m: proto.SyncdRecord, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISyncdSnapshot {
    version?: (proto.ISyncdVersion | null);
    records?: (proto.ISyncdRecord[] | null);
    mac?: (Uint8Array | null);
    keyId?: (proto.IKeyId | null);
  }
  class SyncdSnapshot implements ISyncdSnapshot {
    constructor(p?: proto.ISyncdSnapshot);
    public version?: (proto.ISyncdVersion | null);
    public records: proto.ISyncdRecord[];
    public mac?: (Uint8Array | null);
    public keyId?: (proto.IKeyId | null);
    public static create(properties?: proto.ISyncdSnapshot): proto.SyncdSnapshot;
    public static encode(m: proto.ISyncdSnapshot, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncdSnapshot;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SyncdSnapshot;
    public static toObject(m: proto.SyncdSnapshot, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISyncdValue {
    blob?: (Uint8Array | null);
  }
  class SyncdValue implements ISyncdValue {
    constructor(p?: proto.ISyncdValue);
    public blob?: (Uint8Array | null);
    public static create(properties?: proto.ISyncdValue): proto.SyncdValue;
    public static encode(m: proto.ISyncdValue, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncdValue;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SyncdValue;
    public static toObject(m: proto.SyncdValue, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ISyncdVersion {
    version?: (number | Long$1 | null);
  }
  class SyncdVersion implements ISyncdVersion {
    constructor(p?: proto.ISyncdVersion);
    public version?: (number | Long$1 | null);
    public static create(properties?: proto.ISyncdVersion): proto.SyncdVersion;
    public static encode(m: proto.ISyncdVersion, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.SyncdVersion;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.SyncdVersion;
    public static toObject(m: proto.SyncdVersion, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ITapLinkAction {
    title?: (string | null);
    tapUrl?: (string | null);
  }
  class TapLinkAction implements ITapLinkAction {
    constructor(p?: proto.ITapLinkAction);
    public title?: (string | null);
    public tapUrl?: (string | null);
    public static create(properties?: proto.ITapLinkAction): proto.TapLinkAction;
    public static encode(m: proto.ITapLinkAction, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.TapLinkAction;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.TapLinkAction;
    public static toObject(m: proto.TapLinkAction, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface ITemplateButton {
    index?: (number | null);
    quickReplyButton?: (proto.TemplateButton.IQuickReplyButton | null);
    urlButton?: (proto.TemplateButton.IURLButton | null);
    callButton?: (proto.TemplateButton.ICallButton | null);
  }
  class TemplateButton implements ITemplateButton {
    constructor(p?: proto.ITemplateButton);
    public index?: (number | null);
    public quickReplyButton?: (proto.TemplateButton.IQuickReplyButton | null);
    public urlButton?: (proto.TemplateButton.IURLButton | null);
    public callButton?: (proto.TemplateButton.ICallButton | null);
    public button?: ("quickReplyButton" | "urlButton" | "callButton");
    public static create(properties?: proto.ITemplateButton): proto.TemplateButton;
    public static encode(m: proto.ITemplateButton, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.TemplateButton;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.TemplateButton;
    public static toObject(m: proto.TemplateButton, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace TemplateButton {
    interface ICallButton {
      displayText?: (proto.Message.IHighlyStructuredMessage | null);
      phoneNumber?: (proto.Message.IHighlyStructuredMessage | null);
    }
    class CallButton implements ICallButton {
      constructor(p?: proto.TemplateButton.ICallButton);
      public displayText?: (proto.Message.IHighlyStructuredMessage | null);
      public phoneNumber?: (proto.Message.IHighlyStructuredMessage | null);
      public static create(properties?: proto.TemplateButton.ICallButton): proto.TemplateButton.CallButton;
      public static encode(m: proto.TemplateButton.ICallButton, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.TemplateButton.CallButton;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.TemplateButton.CallButton;
      public static toObject(m: proto.TemplateButton.CallButton, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IQuickReplyButton {
      displayText?: (proto.Message.IHighlyStructuredMessage | null);
      id?: (string | null);
    }
    class QuickReplyButton implements IQuickReplyButton {
      constructor(p?: proto.TemplateButton.IQuickReplyButton);
      public displayText?: (proto.Message.IHighlyStructuredMessage | null);
      public id?: (string | null);
      public static create(properties?: proto.TemplateButton.IQuickReplyButton): proto.TemplateButton.QuickReplyButton;
      public static encode(m: proto.TemplateButton.IQuickReplyButton, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.TemplateButton.QuickReplyButton;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.TemplateButton.QuickReplyButton;
      public static toObject(m: proto.TemplateButton.QuickReplyButton, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    interface IURLButton {
      displayText?: (proto.Message.IHighlyStructuredMessage | null);
      url?: (proto.Message.IHighlyStructuredMessage | null);
    }
    class URLButton implements IURLButton {
      constructor(p?: proto.TemplateButton.IURLButton);
      public displayText?: (proto.Message.IHighlyStructuredMessage | null);
      public url?: (proto.Message.IHighlyStructuredMessage | null);
      public static create(properties?: proto.TemplateButton.IURLButton): proto.TemplateButton.URLButton;
      public static encode(m: proto.TemplateButton.IURLButton, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.TemplateButton.URLButton;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.TemplateButton.URLButton;
      public static toObject(m: proto.TemplateButton.URLButton, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IThreadID {
    threadType?: (proto.ThreadID.ThreadType | null);
    threadKey?: (proto.IMessageKey | null);
  }
  class ThreadID implements IThreadID {
    constructor(p?: proto.IThreadID);
    public threadType?: (proto.ThreadID.ThreadType | null);
    public threadKey?: (proto.IMessageKey | null);
    public static create(properties?: proto.IThreadID): proto.ThreadID;
    public static encode(m: proto.IThreadID, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.ThreadID;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.ThreadID;
    public static toObject(m: proto.ThreadID, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace ThreadID {
    enum ThreadType {
      UNKNOWN = 0,
      VIEW_REPLIES = 1,
      AI_THREAD = 2
    }
  }
  interface IUrlTrackingMap {
    urlTrackingMapElements?: (proto.UrlTrackingMap.IUrlTrackingMapElement[] | null);
  }
  class UrlTrackingMap implements IUrlTrackingMap {
    constructor(p?: proto.IUrlTrackingMap);
    public urlTrackingMapElements: proto.UrlTrackingMap.IUrlTrackingMapElement[];
    public static create(properties?: proto.IUrlTrackingMap): proto.UrlTrackingMap;
    public static encode(m: proto.IUrlTrackingMap, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.UrlTrackingMap;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.UrlTrackingMap;
    public static toObject(m: proto.UrlTrackingMap, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace UrlTrackingMap {
    interface IUrlTrackingMapElement {
      originalUrl?: (string | null);
      unconsentedUsersUrl?: (string | null);
      consentedUsersUrl?: (string | null);
      cardIndex?: (number | null);
    }
    class UrlTrackingMapElement implements IUrlTrackingMapElement {
      constructor(p?: proto.UrlTrackingMap.IUrlTrackingMapElement);
      public originalUrl?: (string | null);
      public unconsentedUsersUrl?: (string | null);
      public consentedUsersUrl?: (string | null);
      public cardIndex?: (number | null);
      public static create(properties?: proto.UrlTrackingMap.IUrlTrackingMapElement): proto.UrlTrackingMap.UrlTrackingMapElement;
      public static encode(m: proto.UrlTrackingMap.IUrlTrackingMapElement, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.UrlTrackingMap.UrlTrackingMapElement;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.UrlTrackingMap.UrlTrackingMapElement;
      public static toObject(m: proto.UrlTrackingMap.UrlTrackingMapElement, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IUserPassword {
    encoding?: (proto.UserPassword.Encoding | null);
    transformer?: (proto.UserPassword.Transformer | null);
    transformerArg?: (proto.UserPassword.ITransformerArg[] | null);
    transformedData?: (Uint8Array | null);
  }
  class UserPassword implements IUserPassword {
    constructor(p?: proto.IUserPassword);
    public encoding?: (proto.UserPassword.Encoding | null);
    public transformer?: (proto.UserPassword.Transformer | null);
    public transformerArg: proto.UserPassword.ITransformerArg[];
    public transformedData?: (Uint8Array | null);
    public static create(properties?: proto.IUserPassword): proto.UserPassword;
    public static encode(m: proto.IUserPassword, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.UserPassword;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.UserPassword;
    public static toObject(m: proto.UserPassword, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace UserPassword {
    enum Encoding {
      UTF8 = 0,
      UTF8_BROKEN = 1
    }
    enum Transformer {
      NONE = 0,
      PBKDF2_HMAC_SHA512 = 1,
      PBKDF2_HMAC_SHA384 = 2
    }
    interface ITransformerArg {
      key?: (string | null);
      value?: (proto.UserPassword.TransformerArg.IValue | null);
    }
    class TransformerArg implements ITransformerArg {
      constructor(p?: proto.UserPassword.ITransformerArg);
      public key?: (string | null);
      public value?: (proto.UserPassword.TransformerArg.IValue | null);
      public static create(properties?: proto.UserPassword.ITransformerArg): proto.UserPassword.TransformerArg;
      public static encode(m: proto.UserPassword.ITransformerArg, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.UserPassword.TransformerArg;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.UserPassword.TransformerArg;
      public static toObject(m: proto.UserPassword.TransformerArg, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
    namespace TransformerArg {
      interface IValue {
        asBlob?: (Uint8Array | null);
        asUnsignedInteger?: (number | null);
      }
      class Value implements IValue {
        constructor(p?: proto.UserPassword.TransformerArg.IValue);
        public asBlob?: (Uint8Array | null);
        public asUnsignedInteger?: (number | null);
        public value?: ("asBlob" | "asUnsignedInteger");
        public static create(properties?: proto.UserPassword.TransformerArg.IValue): proto.UserPassword.TransformerArg.Value;
        public static encode(m: proto.UserPassword.TransformerArg.IValue, w?: Writer): Writer;
        public static decode(r: (Reader | Uint8Array), l?: number): proto.UserPassword.TransformerArg.Value;
        public static fromObject(d: {
          [k: string]: any;
        }): proto.UserPassword.TransformerArg.Value;
        public static toObject(m: proto.UserPassword.TransformerArg.Value, o?: IConversionOptions): {
          [k: string]: any;
        };
        public toJSON(): {
          [k: string]: any;
        };
        public static getTypeUrl(typeUrlPrefix?: string): string;
      }
    }
  }
  interface IUserReceipt {
    userJid?: (string | null);
    receiptTimestamp?: (number | Long$1 | null);
    readTimestamp?: (number | Long$1 | null);
    playedTimestamp?: (number | Long$1 | null);
    pendingDeviceJid?: (string[] | null);
    deliveredDeviceJid?: (string[] | null);
  }
  class UserReceipt implements IUserReceipt {
    constructor(p?: proto.IUserReceipt);
    public userJid: string;
    public receiptTimestamp?: (number | Long$1 | null);
    public readTimestamp?: (number | Long$1 | null);
    public playedTimestamp?: (number | Long$1 | null);
    public pendingDeviceJid: string[];
    public deliveredDeviceJid: string[];
    public static create(properties?: proto.IUserReceipt): proto.UserReceipt;
    public static encode(m: proto.IUserReceipt, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.UserReceipt;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.UserReceipt;
    public static toObject(m: proto.UserReceipt, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IVerifiedNameCertificate {
    details?: (Uint8Array | null);
    signature?: (Uint8Array | null);
    serverSignature?: (Uint8Array | null);
  }
  class VerifiedNameCertificate implements IVerifiedNameCertificate {
    constructor(p?: proto.IVerifiedNameCertificate);
    public details?: (Uint8Array | null);
    public signature?: (Uint8Array | null);
    public serverSignature?: (Uint8Array | null);
    public static create(properties?: proto.IVerifiedNameCertificate): proto.VerifiedNameCertificate;
    public static encode(m: proto.IVerifiedNameCertificate, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.VerifiedNameCertificate;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.VerifiedNameCertificate;
    public static toObject(m: proto.VerifiedNameCertificate, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace VerifiedNameCertificate {
    interface IDetails {
      serial?: (number | Long$1 | null);
      issuer?: (string | null);
      verifiedName?: (string | null);
      localizedNames?: (proto.ILocalizedName[] | null);
      issueTime?: (number | Long$1 | null);
    }
    class Details implements IDetails {
      constructor(p?: proto.VerifiedNameCertificate.IDetails);
      public serial?: (number | Long$1 | null);
      public issuer?: (string | null);
      public verifiedName?: (string | null);
      public localizedNames: proto.ILocalizedName[];
      public issueTime?: (number | Long$1 | null);
      public static create(properties?: proto.VerifiedNameCertificate.IDetails): proto.VerifiedNameCertificate.Details;
      public static encode(m: proto.VerifiedNameCertificate.IDetails, w?: Writer): Writer;
      public static decode(r: (Reader | Uint8Array), l?: number): proto.VerifiedNameCertificate.Details;
      public static fromObject(d: {
        [k: string]: any;
      }): proto.VerifiedNameCertificate.Details;
      public static toObject(m: proto.VerifiedNameCertificate.Details, o?: IConversionOptions): {
        [k: string]: any;
      };
      public toJSON(): {
        [k: string]: any;
      };
      public static getTypeUrl(typeUrlPrefix?: string): string;
    }
  }
  interface IWallpaperSettings {
    filename?: (string | null);
    opacity?: (number | null);
  }
  class WallpaperSettings implements IWallpaperSettings {
    constructor(p?: proto.IWallpaperSettings);
    public filename?: (string | null);
    public opacity?: (number | null);
    public static create(properties?: proto.IWallpaperSettings): proto.WallpaperSettings;
    public static encode(m: proto.IWallpaperSettings, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.WallpaperSettings;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.WallpaperSettings;
    public static toObject(m: proto.WallpaperSettings, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  interface IWebFeatures {
    labelsDisplay?: (proto.WebFeatures.Flag | null);
    voipIndividualOutgoing?: (proto.WebFeatures.Flag | null);
    groupsV3?: (proto.WebFeatures.Flag | null);
    groupsV3Create?: (proto.WebFeatures.Flag | null);
    changeNumberV2?: (proto.WebFeatures.Flag | null);
    queryStatusV3Thumbnail?: (proto.WebFeatures.Flag | null);
    liveLocations?: (proto.WebFeatures.Flag | null);
    queryVname?: (proto.WebFeatures.Flag | null);
    voipIndividualIncoming?: (proto.WebFeatures.Flag | null);
    quickRepliesQuery?: (proto.WebFeatures.Flag | null);
    payments?: (proto.WebFeatures.Flag | null);
    stickerPackQuery?: (proto.WebFeatures.Flag | null);
    liveLocationsFinal?: (proto.WebFeatures.Flag | null);
    labelsEdit?: (proto.WebFeatures.Flag | null);
    mediaUpload?: (proto.WebFeatures.Flag | null);
    mediaUploadRichQuickReplies?: (proto.WebFeatures.Flag | null);
    vnameV2?: (proto.WebFeatures.Flag | null);
    videoPlaybackUrl?: (proto.WebFeatures.Flag | null);
    statusRanking?: (proto.WebFeatures.Flag | null);
    voipIndividualVideo?: (proto.WebFeatures.Flag | null);
    thirdPartyStickers?: (proto.WebFeatures.Flag | null);
    frequentlyForwardedSetting?: (proto.WebFeatures.Flag | null);
    groupsV4JoinPermission?: (proto.WebFeatures.Flag | null);
    recentStickers?: (proto.WebFeatures.Flag | null);
    catalog?: (proto.WebFeatures.Flag | null);
    starredStickers?: (proto.WebFeatures.Flag | null);
    voipGroupCall?: (proto.WebFeatures.Flag | null);
    templateMessage?: (proto.WebFeatures.Flag | null);
    templateMessageInteractivity?: (proto.WebFeatures.Flag | null);
    ephemeralMessages?: (proto.WebFeatures.Flag | null);
    e2ENotificationSync?: (proto.WebFeatures.Flag | null);
    recentStickersV2?: (proto.WebFeatures.Flag | null);
    recentStickersV3?: (proto.WebFeatures.Flag | null);
    userNotice?: (proto.WebFeatures.Flag | null);
    support?: (proto.WebFeatures.Flag | null);
    groupUiiCleanup?: (proto.WebFeatures.Flag | null);
    groupDogfoodingInternalOnly?: (proto.WebFeatures.Flag | null);
    settingsSync?: (proto.WebFeatures.Flag | null);
    archiveV2?: (proto.WebFeatures.Flag | null);
    ephemeralAllowGroupMembers?: (proto.WebFeatures.Flag | null);
    ephemeral24HDuration?: (proto.WebFeatures.Flag | null);
    mdForceUpgrade?: (proto.WebFeatures.Flag | null);
    disappearingMode?: (proto.WebFeatures.Flag | null);
    externalMdOptInAvailable?: (proto.WebFeatures.Flag | null);
    noDeleteMessageTimeLimit?: (proto.WebFeatures.Flag | null);
  }
  class WebFeatures implements IWebFeatures {
    constructor(p?: proto.IWebFeatures);
    public labelsDisplay?: (proto.WebFeatures.Flag | null);
    public voipIndividualOutgoing?: (proto.WebFeatures.Flag | null);
    public groupsV3?: (proto.WebFeatures.Flag | null);
    public groupsV3Create?: (proto.WebFeatures.Flag | null);
    public changeNumberV2?: (proto.WebFeatures.Flag | null);
    public queryStatusV3Thumbnail?: (proto.WebFeatures.Flag | null);
    public liveLocations?: (proto.WebFeatures.Flag | null);
    public queryVname?: (proto.WebFeatures.Flag | null);
    public voipIndividualIncoming?: (proto.WebFeatures.Flag | null);
    public quickRepliesQuery?: (proto.WebFeatures.Flag | null);
    public payments?: (proto.WebFeatures.Flag | null);
    public stickerPackQuery?: (proto.WebFeatures.Flag | null);
    public liveLocationsFinal?: (proto.WebFeatures.Flag | null);
    public labelsEdit?: (proto.WebFeatures.Flag | null);
    public mediaUpload?: (proto.WebFeatures.Flag | null);
    public mediaUploadRichQuickReplies?: (proto.WebFeatures.Flag | null);
    public vnameV2?: (proto.WebFeatures.Flag | null);
    public videoPlaybackUrl?: (proto.WebFeatures.Flag | null);
    public statusRanking?: (proto.WebFeatures.Flag | null);
    public voipIndividualVideo?: (proto.WebFeatures.Flag | null);
    public thirdPartyStickers?: (proto.WebFeatures.Flag | null);
    public frequentlyForwardedSetting?: (proto.WebFeatures.Flag | null);
    public groupsV4JoinPermission?: (proto.WebFeatures.Flag | null);
    public recentStickers?: (proto.WebFeatures.Flag | null);
    public catalog?: (proto.WebFeatures.Flag | null);
    public starredStickers?: (proto.WebFeatures.Flag | null);
    public voipGroupCall?: (proto.WebFeatures.Flag | null);
    public templateMessage?: (proto.WebFeatures.Flag | null);
    public templateMessageInteractivity?: (proto.WebFeatures.Flag | null);
    public ephemeralMessages?: (proto.WebFeatures.Flag | null);
    public e2ENotificationSync?: (proto.WebFeatures.Flag | null);
    public recentStickersV2?: (proto.WebFeatures.Flag | null);
    public recentStickersV3?: (proto.WebFeatures.Flag | null);
    public userNotice?: (proto.WebFeatures.Flag | null);
    public support?: (proto.WebFeatures.Flag | null);
    public groupUiiCleanup?: (proto.WebFeatures.Flag | null);
    public groupDogfoodingInternalOnly?: (proto.WebFeatures.Flag | null);
    public settingsSync?: (proto.WebFeatures.Flag | null);
    public archiveV2?: (proto.WebFeatures.Flag | null);
    public ephemeralAllowGroupMembers?: (proto.WebFeatures.Flag | null);
    public ephemeral24HDuration?: (proto.WebFeatures.Flag | null);
    public mdForceUpgrade?: (proto.WebFeatures.Flag | null);
    public disappearingMode?: (proto.WebFeatures.Flag | null);
    public externalMdOptInAvailable?: (proto.WebFeatures.Flag | null);
    public noDeleteMessageTimeLimit?: (proto.WebFeatures.Flag | null);
    public static create(properties?: proto.IWebFeatures): proto.WebFeatures;
    public static encode(m: proto.IWebFeatures, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.WebFeatures;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.WebFeatures;
    public static toObject(m: proto.WebFeatures, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace WebFeatures {
    enum Flag {
      NOT_STARTED = 0,
      FORCE_UPGRADE = 1,
      DEVELOPMENT = 2,
      PRODUCTION = 3
    }
  }
  enum WebLinkRenderConfig {
    WEBVIEW = 0,
    SYSTEM = 1
  }
  interface IWebMessageInfo {
    key?: (proto.IMessageKey | null);
    message?: (proto.IMessage | null);
    messageTimestamp?: (number | Long$1 | null);
    status?: (proto.WebMessageInfo.Status | null);
    participant?: (string | null);
    messageC2STimestamp?: (number | Long$1 | null);
    ignore?: (boolean | null);
    starred?: (boolean | null);
    broadcast?: (boolean | null);
    pushName?: (string | null);
    mediaCiphertextSha256?: (Uint8Array | null);
    multicast?: (boolean | null);
    urlText?: (boolean | null);
    urlNumber?: (boolean | null);
    messageStubType?: (proto.WebMessageInfo.StubType | null);
    clearMedia?: (boolean | null);
    messageStubParameters?: (string[] | null);
    duration?: (number | null);
    labels?: (string[] | null);
    paymentInfo?: (proto.IPaymentInfo | null);
    finalLiveLocation?: (proto.Message.ILiveLocationMessage | null);
    quotedPaymentInfo?: (proto.IPaymentInfo | null);
    ephemeralStartTimestamp?: (number | Long$1 | null);
    ephemeralDuration?: (number | null);
    ephemeralOffToOn?: (boolean | null);
    ephemeralOutOfSync?: (boolean | null);
    bizPrivacyStatus?: (proto.WebMessageInfo.BizPrivacyStatus | null);
    verifiedBizName?: (string | null);
    mediaData?: (proto.IMediaData | null);
    photoChange?: (proto.IPhotoChange | null);
    userReceipt?: (proto.IUserReceipt[] | null);
    reactions?: (proto.IReaction[] | null);
    quotedStickerData?: (proto.IMediaData | null);
    futureproofData?: (Uint8Array | null);
    statusPsa?: (proto.IStatusPSA | null);
    pollUpdates?: (proto.IPollUpdate[] | null);
    pollAdditionalMetadata?: (proto.IPollAdditionalMetadata | null);
    agentId?: (string | null);
    statusAlreadyViewed?: (boolean | null);
    messageSecret?: (Uint8Array | null);
    keepInChat?: (proto.IKeepInChat | null);
    originalSelfAuthorUserJidString?: (string | null);
    revokeMessageTimestamp?: (number | Long$1 | null);
    pinInChat?: (proto.IPinInChat | null);
    premiumMessageInfo?: (proto.IPremiumMessageInfo | null);
    is1PBizBotMessage?: (boolean | null);
    isGroupHistoryMessage?: (boolean | null);
    botMessageInvokerJid?: (string | null);
    commentMetadata?: (proto.ICommentMetadata | null);
    eventResponses?: (proto.IEventResponse[] | null);
    reportingTokenInfo?: (proto.IReportingTokenInfo | null);
    newsletterServerId?: (number | Long$1 | null);
    eventAdditionalMetadata?: (proto.IEventAdditionalMetadata | null);
    isMentionedInStatus?: (boolean | null);
    statusMentions?: (string[] | null);
    targetMessageId?: (proto.IMessageKey | null);
    messageAddOns?: (proto.IMessageAddOn[] | null);
    statusMentionMessageInfo?: (proto.IStatusMentionMessage | null);
    isSupportAiMessage?: (boolean | null);
    statusMentionSources?: (string[] | null);
    supportAiCitations?: (proto.ICitation[] | null);
    botTargetId?: (string | null);
    groupHistoryIndividualMessageInfo?: (proto.IGroupHistoryIndividualMessageInfo | null);
    groupHistoryBundleInfo?: (proto.IGroupHistoryBundleInfo | null);
    interactiveMessageAdditionalMetadata?: (proto.IInteractiveMessageAdditionalMetadata | null);
    quarantinedMessage?: (proto.IQuarantinedMessage | null);
  }
  class WebMessageInfo implements IWebMessageInfo {
    constructor(p?: proto.IWebMessageInfo);
    public key?: (proto.IMessageKey | null);
    public message?: (proto.IMessage | null);
    public messageTimestamp?: (number | Long$1 | null);
    public status?: (proto.WebMessageInfo.Status | null);
    public participant?: (string | null);
    public messageC2STimestamp?: (number | Long$1 | null);
    public ignore?: (boolean | null);
    public starred?: (boolean | null);
    public broadcast?: (boolean | null);
    public pushName?: (string | null);
    public mediaCiphertextSha256?: (Uint8Array | null);
    public multicast?: (boolean | null);
    public urlText?: (boolean | null);
    public urlNumber?: (boolean | null);
    public messageStubType?: (proto.WebMessageInfo.StubType | null);
    public clearMedia?: (boolean | null);
    public messageStubParameters: string[];
    public duration?: (number | null);
    public labels: string[];
    public paymentInfo?: (proto.IPaymentInfo | null);
    public finalLiveLocation?: (proto.Message.ILiveLocationMessage | null);
    public quotedPaymentInfo?: (proto.IPaymentInfo | null);
    public ephemeralStartTimestamp?: (number | Long$1 | null);
    public ephemeralDuration?: (number | null);
    public ephemeralOffToOn?: (boolean | null);
    public ephemeralOutOfSync?: (boolean | null);
    public bizPrivacyStatus?: (proto.WebMessageInfo.BizPrivacyStatus | null);
    public verifiedBizName?: (string | null);
    public mediaData?: (proto.IMediaData | null);
    public photoChange?: (proto.IPhotoChange | null);
    public userReceipt: proto.IUserReceipt[];
    public reactions: proto.IReaction[];
    public quotedStickerData?: (proto.IMediaData | null);
    public futureproofData?: (Uint8Array | null);
    public statusPsa?: (proto.IStatusPSA | null);
    public pollUpdates: proto.IPollUpdate[];
    public pollAdditionalMetadata?: (proto.IPollAdditionalMetadata | null);
    public agentId?: (string | null);
    public statusAlreadyViewed?: (boolean | null);
    public messageSecret?: (Uint8Array | null);
    public keepInChat?: (proto.IKeepInChat | null);
    public originalSelfAuthorUserJidString?: (string | null);
    public revokeMessageTimestamp?: (number | Long$1 | null);
    public pinInChat?: (proto.IPinInChat | null);
    public premiumMessageInfo?: (proto.IPremiumMessageInfo | null);
    public is1PBizBotMessage?: (boolean | null);
    public isGroupHistoryMessage?: (boolean | null);
    public botMessageInvokerJid?: (string | null);
    public commentMetadata?: (proto.ICommentMetadata | null);
    public eventResponses: proto.IEventResponse[];
    public reportingTokenInfo?: (proto.IReportingTokenInfo | null);
    public newsletterServerId?: (number | Long$1 | null);
    public eventAdditionalMetadata?: (proto.IEventAdditionalMetadata | null);
    public isMentionedInStatus?: (boolean | null);
    public statusMentions: string[];
    public targetMessageId?: (proto.IMessageKey | null);
    public messageAddOns: proto.IMessageAddOn[];
    public statusMentionMessageInfo?: (proto.IStatusMentionMessage | null);
    public isSupportAiMessage?: (boolean | null);
    public statusMentionSources: string[];
    public supportAiCitations: proto.ICitation[];
    public botTargetId?: (string | null);
    public groupHistoryIndividualMessageInfo?: (proto.IGroupHistoryIndividualMessageInfo | null);
    public groupHistoryBundleInfo?: (proto.IGroupHistoryBundleInfo | null);
    public interactiveMessageAdditionalMetadata?: (proto.IInteractiveMessageAdditionalMetadata | null);
    public quarantinedMessage?: (proto.IQuarantinedMessage | null);
    public static create(properties?: proto.IWebMessageInfo): proto.WebMessageInfo;
    public static encode(m: proto.IWebMessageInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.WebMessageInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.WebMessageInfo;
    public static toObject(m: proto.WebMessageInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
  namespace WebMessageInfo {
    enum BizPrivacyStatus {
      E2EE = 0,
      FB = 2,
      BSP = 1,
      BSP_AND_FB = 3
    }
    enum Status {
      ERROR = 0,
      PENDING = 1,
      SERVER_ACK = 2,
      DELIVERY_ACK = 3,
      READ = 4,
      PLAYED = 5
    }
    enum StubType {
      UNKNOWN = 0,
      REVOKE = 1,
      CIPHERTEXT = 2,
      FUTUREPROOF = 3,
      NON_VERIFIED_TRANSITION = 4,
      UNVERIFIED_TRANSITION = 5,
      VERIFIED_TRANSITION = 6,
      VERIFIED_LOW_UNKNOWN = 7,
      VERIFIED_HIGH = 8,
      VERIFIED_INITIAL_UNKNOWN = 9,
      VERIFIED_INITIAL_LOW = 10,
      VERIFIED_INITIAL_HIGH = 11,
      VERIFIED_TRANSITION_ANY_TO_NONE = 12,
      VERIFIED_TRANSITION_ANY_TO_HIGH = 13,
      VERIFIED_TRANSITION_HIGH_TO_LOW = 14,
      VERIFIED_TRANSITION_HIGH_TO_UNKNOWN = 15,
      VERIFIED_TRANSITION_UNKNOWN_TO_LOW = 16,
      VERIFIED_TRANSITION_LOW_TO_UNKNOWN = 17,
      VERIFIED_TRANSITION_NONE_TO_LOW = 18,
      VERIFIED_TRANSITION_NONE_TO_UNKNOWN = 19,
      GROUP_CREATE = 20,
      GROUP_CHANGE_SUBJECT = 21,
      GROUP_CHANGE_ICON = 22,
      GROUP_CHANGE_INVITE_LINK = 23,
      GROUP_CHANGE_DESCRIPTION = 24,
      GROUP_CHANGE_RESTRICT = 25,
      GROUP_CHANGE_ANNOUNCE = 26,
      GROUP_PARTICIPANT_ADD = 27,
      GROUP_PARTICIPANT_REMOVE = 28,
      GROUP_PARTICIPANT_PROMOTE = 29,
      GROUP_PARTICIPANT_DEMOTE = 30,
      GROUP_PARTICIPANT_INVITE = 31,
      GROUP_PARTICIPANT_LEAVE = 32,
      GROUP_PARTICIPANT_CHANGE_NUMBER = 33,
      BROADCAST_CREATE = 34,
      BROADCAST_ADD = 35,
      BROADCAST_REMOVE = 36,
      GENERIC_NOTIFICATION = 37,
      E2E_IDENTITY_CHANGED = 38,
      E2E_ENCRYPTED = 39,
      CALL_MISSED_VOICE = 40,
      CALL_MISSED_VIDEO = 41,
      INDIVIDUAL_CHANGE_NUMBER = 42,
      GROUP_DELETE = 43,
      GROUP_ANNOUNCE_MODE_MESSAGE_BOUNCE = 44,
      CALL_MISSED_GROUP_VOICE = 45,
      CALL_MISSED_GROUP_VIDEO = 46,
      PAYMENT_CIPHERTEXT = 47,
      PAYMENT_FUTUREPROOF = 48,
      PAYMENT_TRANSACTION_STATUS_UPDATE_FAILED = 49,
      PAYMENT_TRANSACTION_STATUS_UPDATE_REFUNDED = 50,
      PAYMENT_TRANSACTION_STATUS_UPDATE_REFUND_FAILED = 51,
      PAYMENT_TRANSACTION_STATUS_RECEIVER_PENDING_SETUP = 52,
      PAYMENT_TRANSACTION_STATUS_RECEIVER_SUCCESS_AFTER_HICCUP = 53,
      PAYMENT_ACTION_ACCOUNT_SETUP_REMINDER = 54,
      PAYMENT_ACTION_SEND_PAYMENT_REMINDER = 55,
      PAYMENT_ACTION_SEND_PAYMENT_INVITATION = 56,
      PAYMENT_ACTION_REQUEST_DECLINED = 57,
      PAYMENT_ACTION_REQUEST_EXPIRED = 58,
      PAYMENT_ACTION_REQUEST_CANCELLED = 59,
      BIZ_VERIFIED_TRANSITION_TOP_TO_BOTTOM = 60,
      BIZ_VERIFIED_TRANSITION_BOTTOM_TO_TOP = 61,
      BIZ_INTRO_TOP = 62,
      BIZ_INTRO_BOTTOM = 63,
      BIZ_NAME_CHANGE = 64,
      BIZ_MOVE_TO_CONSUMER_APP = 65,
      BIZ_TWO_TIER_MIGRATION_TOP = 66,
      BIZ_TWO_TIER_MIGRATION_BOTTOM = 67,
      OVERSIZED = 68,
      GROUP_CHANGE_NO_FREQUENTLY_FORWARDED = 69,
      GROUP_V4_ADD_INVITE_SENT = 70,
      GROUP_PARTICIPANT_ADD_REQUEST_JOIN = 71,
      CHANGE_EPHEMERAL_SETTING = 72,
      E2E_DEVICE_CHANGED = 73,
      VIEWED_ONCE = 74,
      E2E_ENCRYPTED_NOW = 75,
      BLUE_MSG_BSP_FB_TO_BSP_PREMISE = 76,
      BLUE_MSG_BSP_FB_TO_SELF_FB = 77,
      BLUE_MSG_BSP_FB_TO_SELF_PREMISE = 78,
      BLUE_MSG_BSP_FB_UNVERIFIED = 79,
      BLUE_MSG_BSP_FB_UNVERIFIED_TO_SELF_PREMISE_VERIFIED = 80,
      BLUE_MSG_BSP_FB_VERIFIED = 81,
      BLUE_MSG_BSP_FB_VERIFIED_TO_SELF_PREMISE_UNVERIFIED = 82,
      BLUE_MSG_BSP_PREMISE_TO_SELF_PREMISE = 83,
      BLUE_MSG_BSP_PREMISE_UNVERIFIED = 84,
      BLUE_MSG_BSP_PREMISE_UNVERIFIED_TO_SELF_PREMISE_VERIFIED = 85,
      BLUE_MSG_BSP_PREMISE_VERIFIED = 86,
      BLUE_MSG_BSP_PREMISE_VERIFIED_TO_SELF_PREMISE_UNVERIFIED = 87,
      BLUE_MSG_CONSUMER_TO_BSP_FB_UNVERIFIED = 88,
      BLUE_MSG_CONSUMER_TO_BSP_PREMISE_UNVERIFIED = 89,
      BLUE_MSG_CONSUMER_TO_SELF_FB_UNVERIFIED = 90,
      BLUE_MSG_CONSUMER_TO_SELF_PREMISE_UNVERIFIED = 91,
      BLUE_MSG_SELF_FB_TO_BSP_PREMISE = 92,
      BLUE_MSG_SELF_FB_TO_SELF_PREMISE = 93,
      BLUE_MSG_SELF_FB_UNVERIFIED = 94,
      BLUE_MSG_SELF_FB_UNVERIFIED_TO_SELF_PREMISE_VERIFIED = 95,
      BLUE_MSG_SELF_FB_VERIFIED = 96,
      BLUE_MSG_SELF_FB_VERIFIED_TO_SELF_PREMISE_UNVERIFIED = 97,
      BLUE_MSG_SELF_PREMISE_TO_BSP_PREMISE = 98,
      BLUE_MSG_SELF_PREMISE_UNVERIFIED = 99,
      BLUE_MSG_SELF_PREMISE_VERIFIED = 100,
      BLUE_MSG_TO_BSP_FB = 101,
      BLUE_MSG_TO_CONSUMER = 102,
      BLUE_MSG_TO_SELF_FB = 103,
      BLUE_MSG_UNVERIFIED_TO_BSP_FB_VERIFIED = 104,
      BLUE_MSG_UNVERIFIED_TO_BSP_PREMISE_VERIFIED = 105,
      BLUE_MSG_UNVERIFIED_TO_SELF_FB_VERIFIED = 106,
      BLUE_MSG_UNVERIFIED_TO_VERIFIED = 107,
      BLUE_MSG_VERIFIED_TO_BSP_FB_UNVERIFIED = 108,
      BLUE_MSG_VERIFIED_TO_BSP_PREMISE_UNVERIFIED = 109,
      BLUE_MSG_VERIFIED_TO_SELF_FB_UNVERIFIED = 110,
      BLUE_MSG_VERIFIED_TO_UNVERIFIED = 111,
      BLUE_MSG_BSP_FB_UNVERIFIED_TO_BSP_PREMISE_VERIFIED = 112,
      BLUE_MSG_BSP_FB_UNVERIFIED_TO_SELF_FB_VERIFIED = 113,
      BLUE_MSG_BSP_FB_VERIFIED_TO_BSP_PREMISE_UNVERIFIED = 114,
      BLUE_MSG_BSP_FB_VERIFIED_TO_SELF_FB_UNVERIFIED = 115,
      BLUE_MSG_SELF_FB_UNVERIFIED_TO_BSP_PREMISE_VERIFIED = 116,
      BLUE_MSG_SELF_FB_VERIFIED_TO_BSP_PREMISE_UNVERIFIED = 117,
      E2E_IDENTITY_UNAVAILABLE = 118,
      GROUP_CREATING = 119,
      GROUP_CREATE_FAILED = 120,
      GROUP_BOUNCED = 121,
      BLOCK_CONTACT = 122,
      EPHEMERAL_SETTING_NOT_APPLIED = 123,
      SYNC_FAILED = 124,
      SYNCING = 125,
      BIZ_PRIVACY_MODE_INIT_FB = 126,
      BIZ_PRIVACY_MODE_INIT_BSP = 127,
      BIZ_PRIVACY_MODE_TO_FB = 128,
      BIZ_PRIVACY_MODE_TO_BSP = 129,
      DISAPPEARING_MODE = 130,
      E2E_DEVICE_FETCH_FAILED = 131,
      ADMIN_REVOKE = 132,
      GROUP_INVITE_LINK_GROWTH_LOCKED = 133,
      COMMUNITY_LINK_PARENT_GROUP = 134,
      COMMUNITY_LINK_SIBLING_GROUP = 135,
      COMMUNITY_LINK_SUB_GROUP = 136,
      COMMUNITY_UNLINK_PARENT_GROUP = 137,
      COMMUNITY_UNLINK_SIBLING_GROUP = 138,
      COMMUNITY_UNLINK_SUB_GROUP = 139,
      GROUP_PARTICIPANT_ACCEPT = 140,
      GROUP_PARTICIPANT_LINKED_GROUP_JOIN = 141,
      COMMUNITY_CREATE = 142,
      EPHEMERAL_KEEP_IN_CHAT = 143,
      GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST = 144,
      GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE = 145,
      INTEGRITY_UNLINK_PARENT_GROUP = 146,
      COMMUNITY_PARTICIPANT_PROMOTE = 147,
      COMMUNITY_PARTICIPANT_DEMOTE = 148,
      COMMUNITY_PARENT_GROUP_DELETED = 149,
      COMMUNITY_LINK_PARENT_GROUP_MEMBERSHIP_APPROVAL = 150,
      GROUP_PARTICIPANT_JOINED_GROUP_AND_PARENT_GROUP = 151,
      MASKED_THREAD_CREATED = 152,
      MASKED_THREAD_UNMASKED = 153,
      BIZ_CHAT_ASSIGNMENT = 154,
      CHAT_PSA = 155,
      CHAT_POLL_CREATION_MESSAGE = 156,
      CAG_MASKED_THREAD_CREATED = 157,
      COMMUNITY_PARENT_GROUP_SUBJECT_CHANGED = 158,
      CAG_INVITE_AUTO_ADD = 159,
      BIZ_CHAT_ASSIGNMENT_UNASSIGN = 160,
      CAG_INVITE_AUTO_JOINED = 161,
      SCHEDULED_CALL_START_MESSAGE = 162,
      COMMUNITY_INVITE_RICH = 163,
      COMMUNITY_INVITE_AUTO_ADD_RICH = 164,
      SUB_GROUP_INVITE_RICH = 165,
      SUB_GROUP_PARTICIPANT_ADD_RICH = 166,
      COMMUNITY_LINK_PARENT_GROUP_RICH = 167,
      COMMUNITY_PARTICIPANT_ADD_RICH = 168,
      SILENCED_UNKNOWN_CALLER_AUDIO = 169,
      SILENCED_UNKNOWN_CALLER_VIDEO = 170,
      GROUP_MEMBER_ADD_MODE = 171,
      GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD = 172,
      COMMUNITY_CHANGE_DESCRIPTION = 173,
      SENDER_INVITE = 174,
      RECEIVER_INVITE = 175,
      COMMUNITY_ALLOW_MEMBER_ADDED_GROUPS = 176,
      PINNED_MESSAGE_IN_CHAT = 177,
      PAYMENT_INVITE_SETUP_INVITER = 178,
      PAYMENT_INVITE_SETUP_INVITEE_RECEIVE_ONLY = 179,
      PAYMENT_INVITE_SETUP_INVITEE_SEND_AND_RECEIVE = 180,
      LINKED_GROUP_CALL_START = 181,
      REPORT_TO_ADMIN_ENABLED_STATUS = 182,
      EMPTY_SUBGROUP_CREATE = 183,
      SCHEDULED_CALL_CANCEL = 184,
      SUBGROUP_ADMIN_TRIGGERED_AUTO_ADD_RICH = 185,
      GROUP_CHANGE_RECENT_HISTORY_SHARING = 186,
      PAID_MESSAGE_SERVER_CAMPAIGN_ID = 187,
      GENERAL_CHAT_CREATE = 188,
      GENERAL_CHAT_ADD = 189,
      GENERAL_CHAT_AUTO_ADD_DISABLED = 190,
      SUGGESTED_SUBGROUP_ANNOUNCE = 191,
      BIZ_BOT_1P_MESSAGING_ENABLED = 192,
      CHANGE_USERNAME = 193,
      BIZ_COEX_PRIVACY_INIT_SELF = 194,
      BIZ_COEX_PRIVACY_TRANSITION_SELF = 195,
      SUPPORT_AI_EDUCATION = 196,
      BIZ_BOT_3P_MESSAGING_ENABLED = 197,
      REMINDER_SETUP_MESSAGE = 198,
      REMINDER_SENT_MESSAGE = 199,
      REMINDER_CANCEL_MESSAGE = 200,
      BIZ_COEX_PRIVACY_INIT = 201,
      BIZ_COEX_PRIVACY_TRANSITION = 202,
      GROUP_DEACTIVATED = 203,
      COMMUNITY_DEACTIVATE_SIBLING_GROUP = 204,
      EVENT_UPDATED = 205,
      EVENT_CANCELED = 206,
      COMMUNITY_OWNER_UPDATED = 207,
      COMMUNITY_SUB_GROUP_VISIBILITY_HIDDEN = 208,
      CAPI_GROUP_NE2EE_SYSTEM_MESSAGE = 209,
      STATUS_MENTION = 210,
      USER_CONTROLS_SYSTEM_MESSAGE = 211,
      SUPPORT_SYSTEM_MESSAGE = 212,
      CHANGE_LID = 213,
      BIZ_CUSTOMER_3PD_DATA_SHARING_OPT_IN_MESSAGE = 214,
      BIZ_CUSTOMER_3PD_DATA_SHARING_OPT_OUT_MESSAGE = 215,
      CHANGE_LIMIT_SHARING = 216,
      GROUP_MEMBER_LINK_MODE = 217,
      BIZ_AUTOMATICALLY_LABELED_CHAT_SYSTEM_MESSAGE = 218,
      PHONE_NUMBER_HIDING_CHAT_DEPRECATED_MESSAGE = 219,
      QUARANTINED_MESSAGE = 220,
      GROUP_MEMBER_SHARE_GROUP_HISTORY_MODE = 221
    }
  }
  interface IWebNotificationsInfo {
    timestamp?: (number | Long$1 | null);
    unreadChats?: (number | null);
    notifyMessageCount?: (number | null);
    notifyMessages?: (proto.IWebMessageInfo[] | null);
  }
  class WebNotificationsInfo implements IWebNotificationsInfo {
    constructor(p?: proto.IWebNotificationsInfo);
    public timestamp?: (number | Long$1 | null);
    public unreadChats?: (number | null);
    public notifyMessageCount?: (number | null);
    public notifyMessages: proto.IWebMessageInfo[];
    public static create(properties?: proto.IWebNotificationsInfo): proto.WebNotificationsInfo;
    public static encode(m: proto.IWebNotificationsInfo, w?: Writer): Writer;
    public static decode(r: (Reader | Uint8Array), l?: number): proto.WebNotificationsInfo;
    public static fromObject(d: {
      [k: string]: any;
    }): proto.WebNotificationsInfo;
    public static toObject(m: proto.WebNotificationsInfo, o?: IConversionOptions): {
      [k: string]: any;
    };
    public toJSON(): {
      [k: string]: any;
    };
    public static getTypeUrl(typeUrlPrefix?: string): string;
  }
}
//#endregion
//#region node_modules/baileys/lib/Types/Bussines.d.ts
type DayOfWeekBussines = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
type HoursDay = {
  day: DayOfWeekBussines;
  mode: 'specific_hours';
  openTimeInMinutes: string;
  closeTimeInMinutes: string;
} | {
  day: DayOfWeekBussines;
  mode: 'open_24h' | 'appointment_only';
};
type UpdateBussinesProfileProps = {
  address?: string;
  websites?: string[];
  email?: string;
  description?: string;
  hours?: {
    timezone: string;
    days: HoursDay[];
  };
};
type QuickReplyAction = proto.SyncActionValue.IQuickReplyAction & {
  timestamp?: string;
};
//#endregion
//#region node_modules/hookified/dist/node/index.d.ts
type Logger = {
  trace: (message: string, ...arguments_: unknown[]) => void;
  debug: (message: string, ...arguments_: unknown[]) => void;
  info: (message: string, ...arguments_: unknown[]) => void;
  warn: (message: string, ...arguments_: unknown[]) => void;
  error: (message: string, ...arguments_: unknown[]) => void;
  fatal: (message: string, ...arguments_: unknown[]) => void;
};
type EventEmitterOptions = {
  /**
   * Logger instance for logging errors.
   */
  logger?: Logger;
  /**
   * Whether to throw an error when emit 'error' and there are no listeners. Default is false and only emits an error event.
   */
  throwOnEmitError?: boolean;
  /**
   * Whether to throw on 'error' when there are no listeners. This is the standard functionality in EventEmitter
   * @default false - in v2 this will be set to true by default
   */
  throwOnEmptyListeners?: boolean;
};
type IEventEmitter = {
  /**
   * Registers a listener for the specified event.
   *
   * @param eventName - The name (or symbol) of the event to listen for.
   * @param listener - A callback function that will be invoked when the event is emitted.
   * @returns The current instance of EventEmitter for method chaining.
   *
   * @example
   * emitter.on('data', (message) => {
   *   console.log(message);
   * });
   */
  on(eventName: string | symbol, listener: (...arguments_: any[]) => void): IEventEmitter;
  /**
   * Alias for `on`. Registers a listener for the specified event.
   *
   * @param eventName - The name (or symbol) of the event to listen for.
   * @param listener - A callback function that will be invoked when the event is emitted.
   * @returns The current instance of EventEmitter for method chaining.
   */
  addListener(eventName: string | symbol, listener: (...arguments_: any[]) => void): IEventEmitter;
  /**
   * Registers a one-time listener for the specified event. The listener is removed after it is called once.
   *
   * @param eventName - The name (or symbol) of the event to listen for.
   * @param listener - A callback function that will be invoked once when the event is emitted.
   * @returns The current instance of EventEmitter for method chaining.
   *
   * @example
   * emitter.once('close', () => {
   *   console.log('The connection was closed.');
   * });
   */
  once(eventName: string | symbol, listener: (...arguments_: any[]) => void): IEventEmitter;
  /**
   * Removes a previously registered listener for the specified event.
   *
   * @param eventName - The name (or symbol) of the event to stop listening for.
   * @param listener - The specific callback function to remove.
   * @returns The current instance of EventEmitter for method chaining.
   *
   * @example
   * emitter.off('data', myListener);
   */
  off(eventName: string | symbol, listener: (...arguments_: any[]) => void): IEventEmitter;
  /**
   * Alias for `off`. Removes a previously registered listener for the specified event.
   *
   * @param eventName - The name (or symbol) of the event to stop listening for.
   * @param listener - The specific callback function to remove.
   * @returns The current instance of EventEmitter for method chaining.
   */
  removeListener(eventName: string | symbol, listener: (...arguments_: any[]) => void): IEventEmitter;
  /**
   * Emits the specified event, invoking all registered listeners with the provided arguments.
   *
   * @param eventName - The name (or symbol) of the event to emit.
   * @param args - Arguments passed to each listener.
   * @returns `true` if the event had listeners, `false` otherwise.
   *
   * @example
   * emitter.emit('data', 'Hello World');
   */
  emit(eventName: string | symbol, ...arguments_: any[]): boolean;
  /**
   * Returns the number of listeners registered for the specified event.
   *
   * @param eventName - The name (or symbol) of the event.
   * @returns The number of registered listeners.
   *
   * @example
   * const count = emitter.listenerCount('data');
   * console.log(count); // e.g., 2
   */
  listenerCount(eventName: string | symbol): number;
  /**
   * Removes all listeners for the specified event. If no event is specified, it removes all listeners for all events.
   *
   * @param eventName - (Optional) The name (or symbol) of the event.
   * @returns The current instance of EventEmitter for method chaining.
   *
   * @example
   * emitter.removeAllListeners('data');
   */
  removeAllListeners(eventName?: string | symbol): IEventEmitter;
  /**
   * Returns an array of event names for which listeners have been registered.
   *
   * @returns An array of event names (or symbols).
   *
   * @example
   * const events = emitter.eventNames();
   * console.log(events); // e.g., ['data', 'close']
   */
  eventNames(): Array<string | symbol>;
  /**
   * Returns an array of listeners registered for the specified event.
   *
   * @param eventName - The name (or symbol) of the event.
   * @returns An array of listener functions.
   *
   * @example
   * const listeners = emitter.listeners('data');
   * console.log(listeners.length); // e.g., 2
   */
  listeners(eventName: string | symbol): Array<(...arguments_: any[]) => void>;
  /**
   * Returns an array of raw listeners for the specified event. This includes listeners wrapped by internal mechanisms (e.g., once-only listeners).
   *
   * @param eventName - The name (or symbol) of the event.
   * @returns An array of raw listener functions.
   *
   * @example
   * const rawListeners = emitter.rawListeners('data');
   */
  rawListeners(eventName: string | symbol): Array<(...arguments_: any[]) => void>;
  /**
   * Adds a listener to the beginning of the listeners array for the specified event.
   *
   * @param eventName - The name (or symbol) of the event to listen for.
   * @param listener - A callback function that will be invoked when the event is emitted.
   * @returns The current instance of EventEmitter for method chaining.
   *
   * @example
   * emitter.prependListener('data', (message) => {
   *   console.log('This will run first.');
   * });
   */
  prependListener(eventName: string | symbol, listener: (...arguments_: any[]) => void): IEventEmitter;
  /**
   * Adds a one-time listener to the beginning of the listeners array for the specified event.
   *
   * @param eventName - The name (or symbol) of the event to listen for.
   * @param listener - A callback function that will be invoked once when the event is emitted.
   * @returns The current instance of EventEmitter for method chaining.
   *
   * @example
   * emitter.prependOnceListener('data', (message) => {
   *   console.log('This will run first and only once.');
   * });
   */
  prependOnceListener(eventName: string | symbol, listener: (...arguments_: any[]) => void): IEventEmitter;
};
type EventListener = (...arguments_: any[]) => void;
type Hook = (...arguments_: any[]) => Promise<void> | void;
type HookEntry = {
  /**
   * The event name for the hook
   */
  event: string;
  /**
   * The handler function for the hook
   */
  handler: Hook;
};
type HookifiedOptions = {
  /**
   * Whether an error should be thrown when a hook throws an error. Default is false and only emits an error event.
   * @deprecated - this will be deprecated in version 2. Please use throwOnHookError.
   */
  throwHookErrors?: boolean;
  /**
   * Whether an error should be thrown when a hook throws an error. Default is false and only emits an error event.
   */
  throwOnHookError?: boolean;
  /**
   * Whether to enforce that all hook names start with 'before' or 'after'. Default is false.
   * @type {boolean}
   * @default false
   */
  enforceBeforeAfter?: boolean;
  /**
   * Map of deprecated hook names to deprecation messages. When a deprecated hook is used, a warning will be emitted.
   * @type {Map<string, string>}
   * @default new Map()
   */
  deprecatedHooks?: Map<string, string>;
  /**
   * Whether to allow deprecated hooks to be registered and executed. Default is true.
   * @type {boolean}
   * @default true
   */
  allowDeprecated?: boolean;
} & EventEmitterOptions;
declare class Eventified implements IEventEmitter {
  private readonly _eventListeners;
  private _maxListeners;
  private _logger?;
  private _throwOnEmitError;
  private _throwOnEmptyListeners;
  private _errorEvent;
  constructor(options?: EventEmitterOptions);
  /**
   * Gets the logger
   * @returns {Logger}
   */
  get logger(): Logger | undefined;
  /**
   * Sets the logger
   * @param {Logger} logger
   */
  set logger(logger: Logger | undefined);
  /**
   * Gets whether an error should be thrown when an emit throws an error. Default is false and only emits an error event.
   * @returns {boolean}
   */
  get throwOnEmitError(): boolean;
  /**
   * Sets whether an error should be thrown when an emit throws an error. Default is false and only emits an error event.
   * @param {boolean} value
   */
  set throwOnEmitError(value: boolean);
  /**
   * Gets whether an error should be thrown when emitting 'error' event with no listeners. Default is false.
   * @returns {boolean}
   */
  get throwOnEmptyListeners(): boolean;
  /**
   * Sets whether an error should be thrown when emitting 'error' event with no listeners. Default is false.
   * @param {boolean} value
   */
  set throwOnEmptyListeners(value: boolean);
  /**
   * Adds a handler function for a specific event that will run only once
   * @param {string | symbol} eventName
   * @param {EventListener} listener
   * @returns {IEventEmitter} returns the instance of the class for chaining
   */
  once(eventName: string | symbol, listener: EventListener): IEventEmitter;
  /**
   * Gets the number of listeners for a specific event. If no event is provided, it returns the total number of listeners
   * @param {string} eventName The event name. Not required
   * @returns {number} The number of listeners
   */
  listenerCount(eventName?: string | symbol): number;
  /**
   * Gets an array of event names
   * @returns {Array<string | symbol>} An array of event names
   */
  eventNames(): Array<string | symbol>;
  /**
   * Gets an array of listeners for a specific event. If no event is provided, it returns all listeners
   * @param {string} [event] (Optional) The event name
   * @returns {EventListener[]} An array of listeners
   */
  rawListeners(event?: string | symbol): EventListener[];
  /**
   * Prepends a listener to the beginning of the listeners array for the specified event
   * @param {string | symbol} eventName
   * @param {EventListener} listener
   * @returns {IEventEmitter} returns the instance of the class for chaining
   */
  prependListener(eventName: string | symbol, listener: EventListener): IEventEmitter;
  /**
   * Prepends a one-time listener to the beginning of the listeners array for the specified event
   * @param {string | symbol} eventName
   * @param {EventListener} listener
   * @returns {IEventEmitter} returns the instance of the class for chaining
   */
  prependOnceListener(eventName: string | symbol, listener: EventListener): IEventEmitter;
  /**
   * Gets the maximum number of listeners that can be added for a single event
   * @returns {number} The maximum number of listeners
   */
  maxListeners(): number;
  /**
   * Adds a listener for a specific event. It is an alias for the on() method
   * @param {string | symbol} event
   * @param {EventListener} listener
   * @returns {IEventEmitter} returns the instance of the class for chaining
   */
  addListener(event: string | symbol, listener: EventListener): IEventEmitter;
  /**
   * Adds a listener for a specific event
   * @param {string | symbol} event
   * @param {EventListener} listener
   * @returns {IEventEmitter} returns the instance of the class for chaining
   */
  on(event: string | symbol, listener: EventListener): IEventEmitter;
  /**
   * Removes a listener for a specific event. It is an alias for the off() method
   * @param {string | symbol} event
   * @param {EventListener} listener
   * @returns {IEventEmitter} returns the instance of the class for chaining
   */
  removeListener(event: string, listener: EventListener): IEventEmitter;
  /**
   * Removes a listener for a specific event
   * @param {string | symbol} event
   * @param {EventListener} listener
   * @returns {IEventEmitter} returns the instance of the class for chaining
   */
  off(event: string | symbol, listener: EventListener): IEventEmitter;
  /**
   * Calls all listeners for a specific event
   * @param {string | symbol} event
   * @param arguments_ The arguments to pass to the listeners
   * @returns {boolean} Returns true if the event had listeners, false otherwise
   */
  emit(event: string | symbol, ...arguments_: any[]): boolean;
  /**
   * Gets all listeners for a specific event. If no event is provided, it returns all listeners
   * @param {string} [event] (Optional) The event name
   * @returns {EventListener[]} An array of listeners
   */
  listeners(event: string | symbol): EventListener[];
  /**
   * Removes all listeners for a specific event. If no event is provided, it removes all listeners
   * @param {string} [event] (Optional) The event name
   * @returns {IEventEmitter} returns the instance of the class for chaining
   */
  removeAllListeners(event?: string | symbol): IEventEmitter;
  /**
   * Sets the maximum number of listeners that can be added for a single event
   * @param {number} n The maximum number of listeners
   * @returns {void}
   */
  setMaxListeners(n: number): void;
  /**
   * Gets all listeners
   * @returns {EventListener[]} An array of listeners
   */
  getAllListeners(): EventListener[];
  /**
   * Sends a log message using the configured logger based on the event name
   * @param {string | symbol} eventName - The event name that determines the log level
   * @param {unknown} data - The data to log
   */
  private sendLog;
}
declare class Hookified extends Eventified {
  private readonly _hooks;
  private _throwOnHookError;
  private _enforceBeforeAfter;
  private _deprecatedHooks;
  private _allowDeprecated;
  constructor(options?: HookifiedOptions);
  /**
   * Gets all hooks
   * @returns {Map<string, Hook[]>}
   */
  get hooks(): Map<string, Hook[]>;
  /**
   * Gets whether an error should be thrown when a hook throws an error. Default is false and only emits an error event.
   * @returns {boolean}
   * @deprecated - this will be deprecated in version 2. Please use throwOnHookError.
   */
  get throwHookErrors(): boolean;
  /**
   * Sets whether an error should be thrown when a hook throws an error. Default is false and only emits an error event.
   * @param {boolean} value
   * @deprecated - this will be deprecated in version 2. Please use throwOnHookError.
   */
  set throwHookErrors(value: boolean);
  /**
   * Gets whether an error should be thrown when a hook throws an error. Default is false and only emits an error event.
   * @returns {boolean}
   */
  get throwOnHookError(): boolean;
  /**
   * Sets whether an error should be thrown when a hook throws an error. Default is false and only emits an error event.
   * @param {boolean} value
   */
  set throwOnHookError(value: boolean);
  /**
   * Gets whether to enforce that all hook names start with 'before' or 'after'. Default is false.
   * @returns {boolean}
   * @default false
   */
  get enforceBeforeAfter(): boolean;
  /**
   * Sets whether to enforce that all hook names start with 'before' or 'after'. Default is false.
   * @param {boolean} value
   */
  set enforceBeforeAfter(value: boolean);
  /**
   * Gets the map of deprecated hook names to deprecation messages.
   * @returns {Map<string, string>}
   */
  get deprecatedHooks(): Map<string, string>;
  /**
   * Sets the map of deprecated hook names to deprecation messages.
   * @param {Map<string, string>} value
   */
  set deprecatedHooks(value: Map<string, string>);
  /**
   * Gets whether deprecated hooks are allowed to be registered and executed. Default is true.
   * @returns {boolean}
   */
  get allowDeprecated(): boolean;
  /**
   * Sets whether deprecated hooks are allowed to be registered and executed. Default is true.
   * @param {boolean} value
   */
  set allowDeprecated(value: boolean);
  /**
   * Validates hook event name if enforceBeforeAfter is enabled
   * @param {string} event - The event name to validate
   * @throws {Error} If enforceBeforeAfter is true and event doesn't start with 'before' or 'after'
   */
  private validateHookName;
  /**
   * Checks if a hook is deprecated and emits a warning if it is
   * @param {string} event - The event name to check
   * @returns {boolean} - Returns true if the hook should proceed, false if it should be blocked
   */
  private checkDeprecatedHook;
  /**
   * Adds a handler function for a specific event
   * @param {string} event
   * @param {Hook} handler - this can be async or sync
   * @returns {void}
   */
  onHook(event: string, handler: Hook): void;
  /**
   * Adds a handler function for a specific event
   * @param {HookEntry} hookEntry
   * @returns {void}
   */
  onHookEntry(hookEntry: HookEntry): void;
  /**
   * Alias for onHook. This is provided for compatibility with other libraries that use the `addHook` method.
   * @param {string} event
   * @param {Hook} handler - this can be async or sync
   * @returns {void}
   */
  addHook(event: string, handler: Hook): void;
  /**
   * Adds a handler function for a specific event
   * @param {Array<HookEntry>} hooks
   * @returns {void}
   */
  onHooks(hooks: HookEntry[]): void;
  /**
   * Adds a handler function for a specific event that runs before all other handlers
   * @param {string} event
   * @param {Hook} handler - this can be async or sync
   * @returns {void}
   */
  prependHook(event: string, handler: Hook): void;
  /**
   * Adds a handler that only executes once for a specific event before all other handlers
   * @param event
   * @param handler
   */
  prependOnceHook(event: string, handler: Hook): void;
  /**
   * Adds a handler that only executes once for a specific event
   * @param event
   * @param handler
   */
  onceHook(event: string, handler: Hook): void;
  /**
   * Removes a handler function for a specific event
   * @param {string} event
   * @param {Hook} handler
   * @returns {void}
   */
  removeHook(event: string, handler: Hook): void;
  /**
   * Removes all handlers for a specific event
   * @param {Array<HookEntry>} hooks
   * @returns {void}
   */
  removeHooks(hooks: HookEntry[]): void;
  /**
   * Calls all handlers for a specific event
   * @param {string} event
   * @param {T[]} arguments_
   * @returns {Promise<void>}
   */
  hook<T>(event: string, ...arguments_: T[]): Promise<void>;
  /**
   * Calls all synchronous handlers for a specific event.
   * Async handlers (declared with `async` keyword) are silently skipped.
   *
   * Note: The `hook` method is preferred as it executes both sync and async functions.
   * Use `hookSync` only when you specifically need synchronous execution.
   * @param {string} event
   * @param {T[]} arguments_
   * @returns {void}
   */
  hookSync<T>(event: string, ...arguments_: T[]): void;
  /**
   * Prepends the word `before` to your hook. Example is event is `test`, the before hook is `before:test`.
   * @param {string} event - The event name
   * @param {T[]} arguments_ - The arguments to pass to the hook
   */
  beforeHook<T>(event: string, ...arguments_: T[]): Promise<void>;
  /**
   * Prepends the word `after` to your hook. Example is event is `test`, the after hook is `after:test`.
   * @param {string} event - The event name
   * @param {T[]} arguments_ - The arguments to pass to the hook
   */
  afterHook<T>(event: string, ...arguments_: T[]): Promise<void>;
  /**
   * Calls all handlers for a specific event. This is an alias for `hook` and is provided for
   * compatibility with other libraries that use the `callHook` method.
   * @param {string} event
   * @param {T[]} arguments_
   * @returns {Promise<void>}
   */
  callHook<T>(event: string, ...arguments_: T[]): Promise<void>;
  /**
   * Gets all hooks for a specific event
   * @param {string} event
   * @returns {Hook[]}
   */
  getHooks(event: string): Hook[] | undefined;
  /**
   * Removes all hooks
   * @returns {void}
   */
  clearHooks(): void;
}
//#endregion
//#region node_modules/@cacheable/node-cache/dist/index.d.ts
type NodeCacheOptions = {
  /**
   * The standard ttl as number in seconds for every generated cache element. 0 = unlimited, If string, it will be in shorthand format like '1h' for 1 hour
   */
  stdTTL?: number | string;
  /**
   * The interval to check for expired items in seconds. Default is 600 = 5 minutes
   */
  checkperiod?: number;
  /**
   * If set to true (Default Setting), the cache will clone the returned items via get() functions.
   * This means that every time you set a value into the cache, node-cache makes a deep clone of it.
   * When you get that value back, you receive another deep clone.
   * This mimics the behavior of an external cache like Redis or Memcached, meaning mutations to the
   * returned object do not affect the cached copy (and vice versa). If set to false, the original
   * object will be returned, and mutations will affect the cached copy.
   */
  useClones?: boolean;
  /**
   * Delete expired items during an interval check or a single item on a get request. Default is true.
   */
  deleteOnExpire?: boolean;
  /**
   * The maximum number of keys that will be stored in the cache. Default is -1 = unlimited
   * If the limit is reached, it will no longer add any new items until some expire.
   */
  maxKeys?: number;
};
type PartialNodeCacheItem<T> = {
  /**
   * The key of the item
   */
  key: string | number;
  /**
   * The value of the item
   */
  value: T;
  /**
   * The ttl of the item in seconds. 0 = unlimited
   */
  ttl?: number;
};
type NodeCacheItem<T> = PartialNodeCacheItem<T> & {
  /**
   * The ttl of the item in milliseconds. 0 = unlimited
   */
  ttl: number;
};
type NodeCacheStats = {
  /**
   * The number of keys stored in the cache
   */
  keys: number;
  /**
   * The number of hits
   */
  hits: number;
  /**
   * The number of misses
   */
  misses: number;
  /**
   * The global key size count in approximately bytes
   */
  ksize: number;
  /**
   * The global value size count in approximately bytes
   */
  vsize: number;
};
declare class NodeCache<T> extends Hookified {
  readonly options: NodeCacheOptions;
  readonly store: Map<string, NodeCacheItem<T>>;
  private _stats;
  private readonly _cacheable;
  private intervalId;
  constructor(options?: NodeCacheOptions);
  /**
   * Sets a key value pair. It is possible to define a ttl (in seconds). Returns true on success.
   * @param {string | number} key - it will convert the key to a string
   * @param {T} value
   * @param {number | string} [ttl] - this is in seconds and undefined will use the default ttl
   * @returns {boolean}
   */
  set(key: string | number, value: T, ttl?: number | string): boolean;
  /**
   * Sets multiple key val pairs. It is possible to define a ttl (seconds). Returns true on success.
   * @param {PartialNodeCacheItem<T>[]} data an array of key value pairs with optional ttl
   * @returns {boolean}
   */
  mset(data: Array<PartialNodeCacheItem<T>>): boolean;
  /**
   * Gets a saved value from the cache. Returns a undefined if not found or expired. If the value was found it returns the value.
   * @param {string | number} key if the key is a number it will convert it to a string
   * @returns {T} the value or undefined
   */
  get(key: string | number): T | undefined;
  /**
   * Gets multiple saved values from the cache. Returns an empty object {} if not found or expired.
   * If the value was found it returns an object with the key value pair.
   * @param {Array<string | number} keys an array of keys
   * @returns {Record<string, T | undefined>} an object with the key as a property and the value as the value
   */
  mget<T>(keys: Array<string | number>): Record<string, T | undefined>;
  /**
   * Get the cached value and remove the key from the cache. Equivalent to calling get(key) + del(key).
   * Useful for implementing single use mechanism such as OTP, where once a value is read it will become obsolete.
   * @param {string | number} key
   * @returns {T | undefined} the value or undefined
   */
  take<T>(key: string | number): T | undefined;
  /**
   * Delete a key. Returns the number of deleted entries. A delete will never fail.
   * @param {string | number | Array<string | number>} key if the key is a number it will convert it to a string. if an array is passed it will delete all keys in the array.
   * @returns {number} if it was successful it will return the count that was deleted
   */
  del(key: string | number | Array<string | number>): number;
  /**
   * Delete all keys in Array that exist. Returns the number of deleted entries.
   * @param {Array<string | number>} keys an array of keys
   * @returns {number} the count of deleted keys
   */
  mdel(keys: Array<string | number>): number;
  /**
   * Redefine the ttl of a key. Returns true if the key has been found and changed.
   * Otherwise returns false. If the ttl-argument isn't passed the default-TTL will be used.
   * @param {string | number} key if the key is a number it will convert it to a string
   * @param {number | string} [ttl] the ttl in seconds if number, or a shorthand string like '1h' for 1 hour
   * @returns {boolean} true if the key has been found and changed. Otherwise returns false.
   */
  ttl(key: string | number, ttl?: number | string): boolean;
  /**
   * Receive the ttl of a key.
   * @param {string | number} key if the key is a number it will convert it to a string
   * @returns {number | undefined} 0 if this key has no ttl, undefined if this key is not in the cache,
   * a timestamp in ms representing the time at which this key will expire
   */
  getTtl(key: string | number): number | undefined;
  /**
   * Returns an array of all existing keys. [ "all", "my", "keys", "foo", "bar" ]
   * @returns {string[]} an array of all keys
   */
  keys(): string[];
  /**
   * Returns boolean indicating if the key is cached.
   * @param {string | number} key if the key is a number it will convert it to a string
   * @returns {boolean} true if the key is cached
   */
  has(key: string | number): boolean;
  /**
   * Gets the stats of the cache
   * @returns {NodeCacheStats} the stats of the cache
   */
  getStats(): NodeCacheStats;
  /**
   * Flush the whole data.
   * @returns {void}
   */
  flushAll(): void;
  /**
   * Flush the stats.
   * @returns {void}
   */
  flushStats(): void;
  /**
   * Close the cache. This will clear the interval timeout which is set on check period option.
   * @returns {void}
   */
  close(): void;
  /**
   * Get the interval id
   * @returns {number | NodeJS.Timeout} the interval id
   */
  getIntervalId(): number | NodeJS.Timeout;
  startInterval(): void;
  stopInterval(): void;
  private formatKey;
  private getExpirationTimestamp;
  private checkData;
  private createError;
}
//#endregion
//#region node_modules/baileys/lib/Types/Label.d.ts
interface Label {
  /** Label uniq ID */
  id: string;
  /** Label name */
  name: string;
  /** Label color ID */
  color: number;
  /** Is label has been deleted */
  deleted: boolean;
  /** WhatsApp has 5 predefined labels (New customer, New order & etc) */
  predefinedId?: string;
}
interface LabelActionBody {
  id: string;
  /** Label name */
  name?: string;
  /** Label color ID */
  color?: number;
  /** Is label has been deleted */
  deleted?: boolean;
  /** WhatsApp has 5 predefined labels (New customer, New order & etc) */
  predefinedId?: number;
}
//#endregion
//#region node_modules/baileys/lib/Types/Contact.d.ts
interface Contact {
  /** ID either in lid or jid format (preferred) **/
  id: string;
  /** ID in LID format (@lid) **/
  lid?: string;
  /** ID in PN format (@s.whatsapp.net)  **/
  phoneNumber?: string;
  /** name of the contact, you have saved on your WA */
  name?: string;
  /** name of the contact, the contact has set on their own on WA */
  notify?: string;
  /** username associated with this contact, when provided by WA */
  username?: string;
  /** I have no idea */
  verifiedName?: string;
  /**
   * Url of the profile picture of the contact
   *
   * 'changed' => if the profile picture has changed
   * null => if the profile picture has not been set (default profile picture)
   * any other string => url of the profile picture
   */
  imgUrl?: string | null;
  status?: string;
}
//#endregion
//#region node_modules/baileys/lib/Defaults/index.d.ts
declare const MEDIA_HKDF_KEY_MAPPING: {
  audio: string;
  document: string;
  gif: string;
  image: string;
  ppic: string;
  product: string;
  ptt: string;
  sticker: string;
  video: string;
  'thumbnail-document': string;
  'thumbnail-image': string;
  'thumbnail-video': string;
  'thumbnail-link': string;
  'md-msg-hist': string;
  'md-app-state': string;
  'product-catalog-image': string;
  'payment-bg-image': string;
  ptv: string;
  'biz-cover-photo': string;
};
type MediaType = keyof typeof MEDIA_HKDF_KEY_MAPPING;
//#endregion
//#region node_modules/baileys/lib/WABinary/types.d.ts
/**
 * the binary node WA uses internally for communication
 *
 * this is manipulated soley as an object and it does not have any functions.
 * This is done for easy serialization, to prevent running into issues with prototypes &
 * to maintain functional code structure
 * */
type BinaryNode = {
  tag: string;
  attrs: {
    [key: string]: string;
  };
  content?: BinaryNode[] | string | Uint8Array;
};
//#endregion
//#region node_modules/baileys/lib/WABinary/jid-utils.d.ts
type JidWithDevice = {
  user: string;
  device?: number;
};
//#endregion
//#region node_modules/baileys/lib/Types/GroupMetadata.d.ts
type GroupParticipant = Contact & {
  isAdmin?: boolean;
  isSuperAdmin?: boolean;
  admin?: 'admin' | 'superadmin' | null;
};
type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote' | 'modify';
type RequestJoinAction = 'created' | 'revoked' | 'rejected';
type RequestJoinMethod = 'invite_link' | 'linked_group_join' | 'non_admin_add' | undefined;
interface GroupMetadata {
  id: string;
  notify?: string;
  /** group uses 'lid' or 'pn' to send messages */
  addressingMode?: WAMessageAddressingMode;
  owner: string | undefined;
  ownerPn?: string | undefined;
  ownerUsername?: string | undefined;
  owner_country_code?: string | undefined;
  subject: string;
  /** group subject owner */
  subjectOwner?: string;
  subjectOwnerPn?: string;
  subjectOwnerUsername?: string;
  /** group subject modification date */
  subjectTime?: number;
  creation?: number;
  desc?: string;
  descOwner?: string;
  descOwnerPn?: string;
  descOwnerUsername?: string;
  descId?: string;
  descTime?: number;
  /** if this group is part of a community, it returns the jid of the community to which it belongs */
  linkedParent?: string;
  /** is set when the group only allows admins to change group settings */
  restrict?: boolean;
  /** is set when the group only allows admins to write messages */
  announce?: boolean;
  /** is set when the group also allows members to add participants */
  memberAddMode?: boolean;
  /** Request approval to join the group */
  joinApprovalMode?: boolean;
  /** is this a community */
  isCommunity?: boolean;
  /** is this the announce of a community */
  isCommunityAnnounce?: boolean;
  /** number of group participants */
  size?: number;
  participants: GroupParticipant[];
  ephemeralDuration?: number;
  inviteCode?: string;
  /** the person who added you to group or changed some setting in group */
  author?: string;
  authorPn?: string;
  authorUsername?: string;
}
//#endregion
//#region node_modules/baileys/lib/Signal/lid-mapping.d.ts
declare class LIDMappingStore {
  private readonly mappingCache;
  private readonly keys;
  private readonly logger;
  private pnToLIDFunc?;
  private readonly inflightLIDLookups;
  private readonly inflightPNLookups;
  constructor(keys: SignalKeyStoreWithTransaction, logger: ILogger, pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>);
  storeLIDPNMappings(pairs: LIDMapping[]): Promise<void>;
  getLIDForPN(pn: string): Promise<string | null>;
  getLIDsForPNs(pns: string[]): Promise<LIDMapping[] | null>;
  private _getLIDsForPNsImpl;
  getPNForLID(lid: string): Promise<string | null>;
  getPNsForLIDs(lids: string[]): Promise<LIDMapping[] | null>;
  private _getPNsForLIDsImpl;
  /**
   * Close the cache and release resources
   */
  close(): void;
}
//#endregion
//#region node_modules/baileys/lib/Types/Signal.d.ts
type DecryptGroupSignalOpts = {
  group: string;
  authorJid: string;
  msg: Uint8Array;
};
type ProcessSenderKeyDistributionMessageOpts = {
  item: proto.Message.ISenderKeyDistributionMessage;
  authorJid: string;
};
type DecryptSignalProtoOpts = {
  jid: string;
  type: 'pkmsg' | 'msg';
  ciphertext: Uint8Array;
};
type EncryptMessageOpts = {
  jid: string;
  data: Uint8Array;
};
type EncryptGroupMessageOpts = {
  group: string;
  data: Uint8Array;
  meId: string;
};
type GetSenderKeyDistributionMessageOpts = {
  group: string;
  meId: string;
};
type PreKey = {
  keyId: number;
  publicKey: Uint8Array;
};
type SignedPreKey = PreKey & {
  signature: Uint8Array;
};
type E2ESession = {
  registrationId: number;
  identityKey: Uint8Array;
  signedPreKey: SignedPreKey;
  preKey?: PreKey;
};
type E2ESessionOpts = {
  jid: string;
  session: E2ESession;
};
type SignalRepository = {
  decryptGroupMessage(opts: DecryptGroupSignalOpts): Promise<Uint8Array>;
  processSenderKeyDistributionMessage(opts: ProcessSenderKeyDistributionMessageOpts): Promise<void>;
  decryptMessage(opts: DecryptSignalProtoOpts): Promise<Uint8Array>;
  encryptMessage(opts: EncryptMessageOpts): Promise<{
    type: 'pkmsg' | 'msg';
    ciphertext: Uint8Array;
  }>;
  encryptGroupMessage(opts: EncryptGroupMessageOpts): Promise<{
    senderKeyDistributionMessage: Uint8Array;
    ciphertext: Uint8Array;
  }>;
  getSenderKeyDistributionMessage(opts: GetSenderKeyDistributionMessageOpts): Promise<Uint8Array>;
  hasSenderKey(opts: GetSenderKeyDistributionMessageOpts): Promise<boolean>;
  getSessionInfo(jid: string): Promise<{
    baseKey: Uint8Array;
    registrationId: number;
  } | null>;
  injectE2ESession(opts: E2ESessionOpts): Promise<void>;
  validateSession(jid: string): Promise<{
    exists: boolean;
    reason?: string;
  }>;
  jidToSignalProtocolAddress(jid: string): string;
  migrateSession(fromJid: string, toJid: string): Promise<{
    migrated: number;
    skipped: number;
    total: number;
  }>;
  validateSession(jid: string): Promise<{
    exists: boolean;
    reason?: string;
  }>;
  deleteSession(jids: string[]): Promise<void>;
};
interface SignalRepositoryWithLIDStore extends SignalRepository {
  lidMapping: LIDMappingStore;
  close?: () => void;
}
//#endregion
//#region node_modules/baileys/lib/Types/Socket.d.ts
type WAVersion = [number, number, number];
type WABrowserDescription = [string, string, string];
type CacheStore = {
  /** get a cached key and change the stats */get<T>(key: string): Promise<T> | T | undefined; /** set a key in the cache */
  set<T>(key: string, value: T): Promise<void> | void | number | boolean; /** delete a key from the cache */
  del(key: string): void | Promise<void> | number | boolean; /** flush all data */
  flushAll(): void | Promise<void>;
  close?: () => void;
};
type PossiblyExtendedCacheStore = CacheStore & {
  mget?: <T>(keys: string[]) => Promise<Record<string, T | undefined>>;
  mset?: <T>(entries: {
    key: string;
    value: T;
  }[]) => Promise<void> | void | number | boolean;
  mdel?: (keys: string[]) => void | Promise<void> | number | boolean;
};
type PatchedMessageWithRecipientJID = proto.IMessage & {
  recipientJid?: string;
};
type SocketConfig = {
  /** the WS url to connect to WA */waWebSocketUrl: string | URL; /** Fails the connection if the socket times out in this interval */
  connectTimeoutMs: number; /** Default timeout for queries, undefined for no timeout */
  defaultQueryTimeoutMs: number | undefined; /** ping-pong interval for WS connection */
  keepAliveIntervalMs: number;
  /** should baileys use the mobile api instead of the multi device api
   * @deprecated This feature has been removed
   */
  mobile?: boolean; /** proxy agent */
  agent?: Agent; /** logger */
  logger: ILogger; /** version to connect with */
  version: WAVersion; /** override browser config */
  browser: WABrowserDescription; /** Initial pushName carried in the registration ClientPayload (used by mock servers for deterministic phone assignment). */
  pushName?: string; /** agent used for fetch requests -- uploading/downloading media */
  fetchAgent?: Agent;
  /** should the QR be printed in the terminal
   * @deprecated This feature has been removed
   */
  printQRInTerminal?: boolean; /** should events be emitted for actions done by this socket connection */
  emitOwnEvents: boolean; /** custom upload hosts to upload media to */
  customUploadHosts: MediaConnInfo['hosts']; /** time to wait between sending new retry requests */
  retryRequestDelayMs: number; /** max retry count */
  maxMsgRetryCount: number; /** time to wait for the generation of the next QR in ms */
  qrTimeout?: number; /** provide an auth state object to maintain the auth state */
  auth: AuthenticationState; /** manage history processing with this control; by default will sync up everything */
  shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) => boolean; /** transaction capability options for SignalKeyStore */
  transactionOpts: TransactionCapabilityOptions; /** marks the client as online whenever the socket successfully connects */
  markOnlineOnConnect: boolean; /** alphanumeric country code (USA -> US) for the number used */
  countryCode: string; /** provide a cache to store media, so does not have to be re-uploaded */
  mediaCache?: CacheStore;
  /**
   * map to store the retry counts for failed messages;
   * used to determine whether to retry a message or not */
  msgRetryCounterCache?: CacheStore; /** provide a cache to store a user's device list */
  userDevicesCache?: PossiblyExtendedCacheStore; /** cache to store call offers */
  callOfferCache?: CacheStore; /** cache to track placeholder resends */
  placeholderResendCache?: CacheStore; /** width for link preview images */
  linkPreviewImageThumbnailWidth: number; /** Should Baileys ask the phone for full history, will be received async */
  syncFullHistory: boolean; /** Should baileys fire init queries automatically, default true */
  fireInitQueries: boolean;
  /**
   * generate a high quality link preview,
   * entails uploading the jpegThumbnail to WA
   * */
  generateHighQualityLinkPreview: boolean; /** Enable automatic session recreation for failed messages */
  enableAutoSessionRecreation: boolean; /** Enable recent message caching for retry handling */
  enableRecentMessageCache: boolean;
  /**
   * Returns if a jid should be ignored,
   * no event for that jid will be triggered.
   * Messages from that jid will also not be decrypted
   * */
  shouldIgnoreJid: (jid: string) => boolean | undefined;
  /**
   * Optionally patch the message before sending out
   * */
  patchMessageBeforeSending: (msg: proto.IMessage, recipientJids?: string[]) => Promise<PatchedMessageWithRecipientJID[] | PatchedMessageWithRecipientJID> | PatchedMessageWithRecipientJID[] | PatchedMessageWithRecipientJID; /** verify app state MACs */
  appStateMacVerification: {
    patch: boolean;
    snapshot: boolean;
  }; /** options for HTTP fetch requests */
  options: RequestInit;
  /**
   * fetch a message from your store
   * implement this so that messages failed to send
   * (solves the "this message can take a while" issue) can be retried
   * */
  getMessage: (key: WAMessageKey) => Promise<proto.IMessage | undefined>; /** cached group metadata, use to prevent redundant requests to WA & speed up msg sending */
  cachedGroupMetadata: (jid: string) => Promise<GroupMetadata | undefined>;
  makeSignalRepository: (auth: SignalAuthState, logger: ILogger, pnToLIDFunc?: (jids: string[]) => Promise<LIDMapping[] | undefined>) => SignalRepositoryWithLIDStore;
};
//#endregion
//#region node_modules/baileys/lib/Types/Message.d.ts
type WAMessage = proto.IWebMessageInfo & {
  key: WAMessageKey;
  messageStubParameters?: any;
  category?: string;
  retryCount?: number;
};
type WAMessageKey = proto.IMessageKey & {
  remoteJidAlt?: string;
  remoteJidUsername?: string;
  participantAlt?: string;
  participantUsername?: string;
  server_id?: string;
  addressingMode?: string;
  isViewOnce?: boolean;
};
type WALocationMessage = proto.Message.ILocationMessage;
type WAMediaPayloadURL = {
  url: URL | string;
};
type WAMediaPayloadStream = {
  stream: Readable;
};
type WAMediaUpload = Buffer | WAMediaPayloadStream | WAMediaPayloadURL;
declare enum WAMessageAddressingMode {
  PN = "pn",
  LID = "lid"
}
type MessageReceiptType = 'read' | 'read-self' | 'hist_sync' | 'peer_msg' | 'sender' | 'inactive' | 'played' | undefined;
type MediaConnInfo = {
  auth: string;
  ttl: number;
  hosts: {
    hostname: string;
    maxContentLengthBytes: number;
  }[];
  fetchDate: Date;
};
interface WAUrlInfo {
  'canonical-url': string;
  'matched-text': string;
  title: string;
  description?: string;
  jpegThumbnail?: Buffer;
  highQualityThumbnail?: proto.Message.IImageMessage;
  originalThumbnailUrl?: string;
}
type Mentionable = {
  /** list of jids that are mentioned in the accompanying text */mentions?: string[]; /** mention all */
  mentionAll?: boolean;
};
type Contextable = {
  /** add contextInfo to the message */contextInfo?: proto.IContextInfo;
};
type ViewOnce = {
  viewOnce?: boolean;
};
type Editable = {
  edit?: WAMessageKey;
};
type WithDimensions = {
  width?: number;
  height?: number;
};
type PollMessageOptions = {
  name: string;
  selectableCount?: number;
  values: string[]; /** 32 byte message secret to encrypt poll selections */
  messageSecret?: Uint8Array;
  toAnnouncementGroup?: boolean;
};
type EventMessageOptions = {
  name: string;
  description?: string;
  startDate: Date;
  endDate?: Date;
  location?: WALocationMessage;
  call?: 'audio' | 'video';
  isCancelled?: boolean;
  isScheduleCall?: boolean;
  extraGuestsAllowed?: boolean;
  messageSecret?: Uint8Array<ArrayBufferLike>;
};
type AlbumMessageOptions = {
  /** Number of images expected in the album */expectedImageCount?: number; /** Number of videos expected in the album */
  expectedVideoCount?: number;
};
type SharePhoneNumber = {
  sharePhoneNumber: boolean;
};
type RequestPhoneNumber = {
  requestPhoneNumber: boolean;
};
type AnyMediaMessageContent = (({
  image: WAMediaUpload;
  caption?: string;
  jpegThumbnail?: string;
} & Mentionable & Contextable & WithDimensions) | ({
  video: WAMediaUpload;
  caption?: string;
  gifPlayback?: boolean;
  jpegThumbnail?: string; /** if set to true, will send as a `video note` */
  ptv?: boolean;
} & Mentionable & Contextable & WithDimensions) | {
  audio: WAMediaUpload; /** if set to true, will send as a `voice note` */
  ptt?: boolean; /** optionally tell the duration of the audio */
  seconds?: number;
} | ({
  sticker: WAMediaUpload;
  isAnimated?: boolean;
} & WithDimensions) | ({
  document: WAMediaUpload;
  mimetype: string;
  fileName?: string;
  caption?: string;
} & Contextable)) & {
  mimetype?: string;
} & Editable & {
  /** key of the parent albumMessage to associate this media with */albumParentKey?: WAMessageKey;
};
type ButtonReplyInfo = {
  displayText: string;
  id: string;
  index: number;
};
type GroupInviteInfo = {
  inviteCode: string;
  inviteExpiration: number;
  text: string;
  jid: string;
  subject: string;
};
type WASendableProduct = Omit<proto.Message.ProductMessage.IProductSnapshot, 'productImage'> & {
  productImage: WAMediaUpload;
};
type AnyRegularMessageContent = (({
  text: string;
  linkPreview?: WAUrlInfo | null;
} & Mentionable & Contextable & Editable) | AnyMediaMessageContent | {
  event: EventMessageOptions;
} | ({
  poll: PollMessageOptions;
} & Mentionable & Contextable & Editable) | ({
  album: AlbumMessageOptions;
} & Contextable & Mentionable) | {
  contacts: {
    displayName?: string;
    contacts: proto.Message.IContactMessage[];
  };
} | {
  location: WALocationMessage;
} | {
  react: proto.Message.IReactionMessage;
} | {
  buttonReply: ButtonReplyInfo;
  type: 'template' | 'plain';
} | {
  groupInvite: GroupInviteInfo;
} | {
  listReply: Omit<proto.Message.IListResponseMessage, 'contextInfo'>;
} | {
  pin: WAMessageKey;
  type: proto.PinInChat.Type;
  /**
   * 24 hours, 7 days, 30 days
   */
  time?: 86400 | 604800 | 2592000;
} | {
  product: WASendableProduct;
  businessOwnerJid?: string;
  body?: string;
  footer?: string;
} | SharePhoneNumber | RequestPhoneNumber) & ViewOnce;
type AnyMessageContent = AnyRegularMessageContent | {
  forward: WAMessage;
  force?: boolean;
} | {
  /** Delete your message or anyone's message in a group (admin required) */delete: WAMessageKey;
} | {
  disappearingMessagesInChat: boolean | number;
} | {
  limitSharing: boolean;
};
type MinimalRelayOptions = {
  /** override the message ID with a custom provided string */messageId?: string; /** should we use group metadata cache, or fetch afresh from the server; default assumed to be "true" */
  useCachedGroupMetadata?: boolean;
};
type MessageRelayOptions = MinimalRelayOptions & {
  /** only send to a specific participant; used when a message decryption fails for a single user */participant?: {
    jid: string;
    count: number;
  }; /** additional attributes to add to the WA binary node */
  additionalAttributes?: {
    [_: string]: string;
  };
  additionalNodes?: BinaryNode[]; /** should we use the devices cache, or fetch afresh from the server; default assumed to be "true" */
  useUserDevicesCache?: boolean; /** jid list of participants for status@broadcast */
  statusJidList?: string[];
};
type MiscMessageGenerationOptions = MinimalRelayOptions & {
  /** optional, if you want to manually set the timestamp of the message */timestamp?: Date; /** the message you want to quote */
  quoted?: WAMessage; /** disappearing messages settings */
  ephemeralExpiration?: number | string; /** timeout for media upload to WA server */
  mediaUploadTimeoutMs?: number; /** jid list of participants for status@broadcast */
  statusJidList?: string[]; /** backgroundcolor for status */
  backgroundColor?: string; /** font type for status */
  font?: number; /** if it is broadcast */
  broadcast?: boolean;
};
type WAMediaUploadFunction = (encFilePath: string, opts: {
  fileEncSha256B64: string;
  mediaType: MediaType;
  timeoutMs?: number;
}) => Promise<{
  mediaUrl: string;
  directPath: string;
  meta_hmac?: string;
  ts?: number;
  fbid?: number;
}>;
/**
 * Type of message upsert
 * 1. notify => notify the user, this message was just received
 * 2. append => append the message to the chat history, no notification required
 */
type MessageUpsertType = 'append' | 'notify';
type MessageUserReceipt = proto.IUserReceipt;
type WAMessageUpdate = {
  update: Partial<WAMessage>;
  key: WAMessageKey;
};
type MessageUserReceiptUpdate = {
  key: WAMessageKey;
  receipt: MessageUserReceipt;
};
type MinimalMessage = Pick<WAMessage, 'key' | 'messageTimestamp'>;
//#endregion
//#region node_modules/baileys/lib/Types/Auth.d.ts
type KeyPair = {
  public: Uint8Array;
  private: Uint8Array;
};
type SignedKeyPair = {
  keyPair: KeyPair;
  signature: Uint8Array;
  keyId: number;
  timestampS?: number;
};
type ProtocolAddress = {
  name: string;
  deviceId: number;
};
type SignalIdentity = {
  identifier: ProtocolAddress;
  identifierKey: Uint8Array;
};
type LIDMapping = {
  pn: string;
  lid: string;
};
type LTHashState = {
  version: number;
  hash: Buffer;
  indexValueMap: {
    [indexMacBase64: string]: {
      valueMac: Uint8Array | Buffer;
    };
  };
};
type SignalCreds = {
  readonly signedIdentityKey: KeyPair;
  readonly signedPreKey: SignedKeyPair;
  readonly registrationId: number;
};
type AccountSettings = {
  /** unarchive chats when a new message is received */unarchiveChats: boolean; /** the default mode to start new conversations with */
  defaultDisappearingMode?: Pick<proto.IConversation, 'ephemeralExpiration' | 'ephemeralSettingTimestamp'>;
};
type AuthenticationCreds = SignalCreds & {
  readonly noiseKey: KeyPair;
  readonly pairingEphemeralKeyPair: KeyPair;
  advSecretKey: string;
  me?: Contact;
  account?: proto.IADVSignedDeviceIdentity;
  signalIdentities?: SignalIdentity[];
  myAppStateKeyId?: string;
  firstUnuploadedPreKeyId: number;
  nextPreKeyId: number;
  lastAccountSyncTimestamp?: number;
  platform?: string;
  processedHistoryMessages: MinimalMessage[]; /** number of times history & app state has been synced */
  accountSyncCounter: number;
  accountSettings: AccountSettings;
  registered: boolean;
  pairingCode: string | undefined;
  lastPropHash: string | undefined;
  routingInfo: Buffer | undefined;
  additionalData?: any | undefined;
};
type SignalDataTypeMap = {
  'pre-key': KeyPair;
  session: Uint8Array;
  'sender-key': Uint8Array;
  'sender-key-memory': {
    [jid: string]: boolean;
  };
  'app-state-sync-key': proto.Message.IAppStateSyncKeyData;
  'app-state-sync-version': LTHashState;
  'lid-mapping': string;
  'device-list': string[];
  tctoken: {
    token: Buffer;
    timestamp?: string;
    senderTimestamp?: number;
  };
  'identity-key': Uint8Array;
};
type SignalDataSet = { [T in keyof SignalDataTypeMap]?: {
  [id: string]: SignalDataTypeMap[T] | null;
} };
type Awaitable<T> = T | Promise<T>;
type SignalKeyStore = {
  get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Awaitable<{
    [id: string]: SignalDataTypeMap[T];
  }>;
  set(data: SignalDataSet): Awaitable<void>; /** clear all the data in the store */
  clear?(): Awaitable<void>;
};
type SignalKeyStoreWithTransaction = SignalKeyStore & {
  isInTransaction: () => boolean;
  transaction<T>(exec: () => Promise<T>, key: string): Promise<T>;
};
type TransactionCapabilityOptions = {
  maxCommitRetries: number;
  delayBetweenTriesMs: number;
};
type SignalAuthState = {
  creds: SignalCreds;
  keys: SignalKeyStore | SignalKeyStoreWithTransaction;
};
type AuthenticationState = {
  creds: AuthenticationCreds;
  keys: SignalKeyStore;
};
//#endregion
//#region node_modules/@hapi/boom/lib/index.d.ts
/**
 * An Error object used to return an HTTP response error (4xx, 5xx)
 */
declare class Boom<Data = any> extends Error {
  /**
   * Creates a new Boom object using the provided message
   */
  constructor(message?: string | Error, options?: Options<Data>);
  /**
   * Custom error data with additional information specific to the error type
   */
  data?: Data;
  /**
   * isBoom - if true, indicates this is a Boom object instance.
   */
  isBoom: boolean;
  /**
   * Convenience boolean indicating status code >= 500
   */
  isServer: boolean;
  /**
   * The error message
   */
  message: string;
  /**
   * The formatted response
   */
  output: Output;
  /**
   * The constructor used to create the error
   */
  typeof: Function;
  /**
   * Specifies if an error object is a valid boom object
   *
   * @param debug - A boolean that, when true, does not hide the original 500 error message. Defaults to false.
   */
  reformat(debug?: boolean): string;
}
interface Options<Data> {
  /**
   * The HTTP status code
   *
   * @default 500
   */
  statusCode?: number;
  /**
   * Additional error information
   */
  data?: Data;
  /**
   * Constructor reference used to crop the exception call stack output
   */
  ctor?: Function;
  /**
   * Error message string
   *
   * @default none
   */
  message?: string;
  /**
   * If false, the err provided is a Boom object, and a statusCode or message are provided, the values are ignored
   *
   * @default true
   */
  override?: boolean;
}
interface Payload {
  /**
   * The HTTP status code derived from error.output.statusCode
   */
  statusCode: number;
  /**
   * The HTTP status message derived from statusCode
   */
  error: string;
  /**
   * The error message derived from error.message
   */
  message: string;
  /**
   * Custom properties
   */
  [key: string]: unknown;
}
interface Output {
  /**
   * The HTTP status code
   */
  statusCode: number;
  /**
   * An object containing any HTTP headers where each key is a header name and value is the header content
   */
  headers: {
    [header: string]: string | string[] | number | undefined;
  };
  /**
   * The formatted object used as the response payload (stringified)
   */
  payload: Payload;
}
//#endregion
//#region node_modules/baileys/lib/Types/Call.d.ts
type WACallUpdateType = 'offer' | 'ringing' | 'preaccept' | 'transport' | 'relaylatency' | 'timeout' | 'reject' | 'accept' | 'terminate';
type WACallEvent = {
  chatId: string;
  from: string;
  callerPn?: string;
  isGroup?: boolean;
  groupJid?: string;
  id: string;
  date: Date;
  isVideo?: boolean;
  status: WACallUpdateType;
  offline: boolean;
  latencyMs?: number;
};
//#endregion
//#region node_modules/baileys/lib/Types/LabelAssociation.d.ts
/** Association type */
declare enum LabelAssociationType {
  Chat = "label_jid",
  Message = "label_message"
}
/** Association for chat */
interface ChatLabelAssociation {
  type: LabelAssociationType.Chat;
  chatId: string;
  labelId: string;
}
/** Association for message */
interface MessageLabelAssociation {
  type: LabelAssociationType.Message;
  chatId: string;
  messageId: string;
  labelId: string;
}
type LabelAssociation = ChatLabelAssociation | MessageLabelAssociation;
/** Body for add/remove chat label association action */
interface ChatLabelAssociationActionBody {
  labelId: string;
}
/** body for add/remove message label association action */
interface MessageLabelAssociationActionBody {
  labelId: string;
  messageId: string;
}
//#endregion
//#region node_modules/baileys/lib/Types/State.d.ts
type WAConnectionState = 'open' | 'connecting' | 'close';
type ConnectionState = {
  /** connection is now open, connecting or closed */connection: WAConnectionState; /** the error that caused the connection to close */
  lastDisconnect?: {
    error: Boom | Error | undefined;
    date: Date;
  }; /** is this a new login */
  isNewLogin?: boolean; /** the current QR code */
  qr?: string; /** has the device received all pending notifications while it was offline */
  receivedPendingNotifications?: boolean; /** legacy connection options */
  legacy?: {
    phoneConnected: boolean;
    user?: Contact;
  };
  /**
   * if the client is shown as an active, online client.
   * If this is false, the primary phone and other devices will receive notifs
   * */
  isOnline?: boolean;
  /**
   * When you are in this state, WhatsApp prevents outgoing messages and calls.
   */
  reachoutTimeLock?: ReachoutTimelockState;
};
type ReachoutTimelockState = {
  isActive?: boolean;
  timeEnforcementEnds?: Date;
  enforcementType?: ReachoutTimelockEnforcementType;
};
declare enum ReachoutTimelockEnforcementType {
  BIZ_COMMERCE_VIOLATION_ALCOHOL = "BIZ_COMMERCE_VIOLATION_ALCOHOL",
  BIZ_COMMERCE_VIOLATION_ADULT = "BIZ_COMMERCE_VIOLATION_ADULT",
  BIZ_COMMERCE_VIOLATION_ANIMALS = "BIZ_COMMERCE_VIOLATION_ANIMALS",
  BIZ_COMMERCE_VIOLATION_BODY_PARTS_FLUIDS = "BIZ_COMMERCE_VIOLATION_BODY_PARTS_FLUIDS",
  BIZ_COMMERCE_VIOLATION_DATING = "BIZ_COMMERCE_VIOLATION_DATING",
  BIZ_COMMERCE_VIOLATION_DIGITAL_SERVICES_PRODUCTS = "BIZ_COMMERCE_VIOLATION_DIGITAL_SERVICES_PRODUCTS",
  BIZ_COMMERCE_VIOLATION_DRUGS = "BIZ_COMMERCE_VIOLATION_DRUGS",
  BIZ_COMMERCE_VIOLATION_DRUGS_ONLY_OTC = "BIZ_COMMERCE_VIOLATION_DRUGS_ONLY_OTC",
  BIZ_COMMERCE_VIOLATION_GAMBLING = "BIZ_COMMERCE_VIOLATION_GAMBLING",
  BIZ_COMMERCE_VIOLATION_HEALTHCARE = "BIZ_COMMERCE_VIOLATION_HEALTHCARE",
  BIZ_COMMERCE_VIOLATION_REAL_FAKE_CURRENCY = "BIZ_COMMERCE_VIOLATION_REAL_FAKE_CURRENCY",
  BIZ_COMMERCE_VIOLATION_SUPPLEMENTS = "BIZ_COMMERCE_VIOLATION_SUPPLEMENTS",
  BIZ_COMMERCE_VIOLATION_TOBACCO = "BIZ_COMMERCE_VIOLATION_TOBACCO",
  BIZ_COMMERCE_VIOLATION_VIOLENT_CONTENT = "BIZ_COMMERCE_VIOLATION_VIOLENT_CONTENT",
  BIZ_COMMERCE_VIOLATION_WEAPONS = "BIZ_COMMERCE_VIOLATION_WEAPONS",
  BIZ_QUALITY = "BIZ_QUALITY",
  /** This means there is no restriction */
  DEFAULT = "DEFAULT",
  WEB_COMPANION_ONLY = "WEB_COMPANION_ONLY"
}
declare enum NewChatMessageCappingStatusType {
  NONE = "NONE",
  FIRST_WARNING = "FIRST_WARNING",
  SECOND_WARNING = "SECOND_WARNING",
  CAPPED = "CAPPED"
}
declare enum NewChatMessageCappingMVStatusType {
  NOT_ELIGIBLE = "NOT_ELIGIBLE",
  NOT_ACTIVE = "NOT_ACTIVE",
  ACTIVE = "ACTIVE",
  ACTIVE_UPGRADE_AVAILABLE = "ACTIVE_UPGRADE_AVAILABLE"
}
declare enum NewChatMessageCappingOTEStatusType {
  NOT_ELIGIBLE = "NOT_ELIGIBLE",
  ELIGIBLE = "ELIGIBLE",
  ACTIVE_IN_CURRENT_CYCLE = "ACTIVE_IN_CURRENT_CYCLE",
  EXHAUSTED = "EXHAUSTED"
}
type NewChatMessageCapInfo = {
  total_quota?: number;
  used_quota?: number;
  cycle_start_timestamp?: string;
  cycle_end_timestamp?: string;
  server_sent_timestamp?: string;
  ote_status?: NewChatMessageCappingOTEStatusType;
  mv_status?: NewChatMessageCappingMVStatusType;
  capping_status?: NewChatMessageCappingStatusType;
};
//#endregion
//#region node_modules/baileys/lib/Types/Events.d.ts
type BaileysEventMap = {
  /** connection state has been updated -- WS closed, opened, connecting etc. */'connection.update': Partial<ConnectionState>; /** credentials updated -- some metadata, keys or something */
  'creds.update': Partial<AuthenticationCreds>; /** set chats (history sync), everything is reverse chronologically sorted */
  'messaging-history.set': {
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings?: LIDMapping[];
    isLatest?: boolean;
    progress?: number | null;
    syncType?: proto.HistorySync.HistorySyncType | null;
    pastParticipants?: proto.IPastParticipants[] | null;
    chunkOrder?: number | null;
    peerDataRequestSessionId?: string | null;
  }; /** signals history sync milestones (completion or stall) per sync type */
  'messaging-history.status': {
    /** which sync phase this status refers to */syncType: proto.HistorySync.HistorySyncType; /** the status of this sync phase */
    status: 'complete' | 'paused';
    /**
     * progress === 100 was received from the server.
     * when false, completion was inferred via timeout (no more chunks arriving).
     */
    explicit: boolean;
  }; /** upsert chats */
  'chats.upsert': Chat[]; /** update the given chats */
  'chats.update': ChatUpdate[];
  'lid-mapping.update': LIDMapping; /** delete chats with given ID */
  'chats.delete': string[]; /** presence of contact in a chat updated */
  'presence.update': {
    id: string;
    presences: {
      [participant: string]: PresenceData;
    };
  };
  'contacts.upsert': Contact[];
  'contacts.update': Partial<Contact>[];
  'messages.delete': {
    keys: WAMessageKey[];
  } | {
    jid: string;
    all: true;
  };
  'messages.update': WAMessageUpdate[];
  'messages.media-update': {
    key: WAMessageKey;
    media?: {
      ciphertext: Uint8Array;
      iv: Uint8Array;
    };
    error?: Boom;
  }[];
  /**
   * add/update the given messages. If they were received while the connection was online,
   * the update will have type: "notify"
   * if requestId is provided, then the messages was received from the phone due to it being unavailable
   *  */
  'messages.upsert': {
    messages: WAMessage[];
    type: MessageUpsertType;
    requestId?: string;
  }; /** message was reacted to. If reaction was removed -- then "reaction.text" will be falsey */
  'messages.reaction': {
    key: WAMessageKey;
    reaction: proto.IReaction;
  }[];
  'message-receipt.update': MessageUserReceiptUpdate[];
  'groups.upsert': GroupMetadata[];
  'groups.update': Partial<GroupMetadata>[]; /** apply an action to participants in a group */
  'group-participants.update': {
    id: string;
    author: string;
    authorPn?: string;
    authorUsername?: string;
    participants: GroupParticipant[];
    action: ParticipantAction;
  };
  'group.join-request': {
    id: string;
    author: string;
    authorPn?: string;
    authorUsername?: string;
    participant: string;
    participantPn?: string;
    action: RequestJoinAction;
    method: RequestJoinMethod;
  };
  'group.member-tag.update': {
    groupId: string;
    participant: string;
    participantAlt?: string;
    label: string;
    messageTimestamp?: number;
  };
  'blocklist.set': {
    blocklist: string[];
  };
  'blocklist.update': {
    blocklist: string[];
    type: 'add' | 'remove';
  }; /** Receive an update on a call, including when the call was received, rejected, accepted */
  call: WACallEvent[];
  'labels.edit': Label;
  'labels.association': {
    association: LabelAssociation;
    type: 'add' | 'remove';
  }; /** Newsletter-related events */
  'newsletter.reaction': {
    id: string;
    server_id: string;
    reaction: {
      code?: string;
      count?: number;
      removed?: boolean;
    };
  };
  'newsletter.view': {
    id: string;
    server_id: string;
    count: number;
  };
  'newsletter-participants.update': {
    id: string;
    author: string;
    user: string;
    new_role: string;
    action: string;
  };
  'newsletter-settings.update': {
    id: string;
    update: any;
  };
  'message-capping.update': NewChatMessageCapInfo; /** Settings and actions sync events */
  'chats.lock': {
    id: string;
    locked: boolean;
  };
  'settings.update': {
    setting: 'unarchiveChats';
    value: boolean;
  } | {
    setting: 'locale';
    value: string;
  } | {
    setting: 'disableLinkPreviews';
    value: proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction;
  } | {
    setting: 'timeFormat';
    value: proto.SyncActionValue.ITimeFormatAction;
  } | {
    setting: 'privacySettingRelayAllCalls';
    value: proto.SyncActionValue.IPrivacySettingRelayAllCalls;
  } | {
    setting: 'statusPrivacy';
    value: proto.SyncActionValue.IStatusPrivacyAction;
  } | {
    setting: 'notificationActivitySetting';
    value: proto.SyncActionValue.NotificationActivitySettingAction.NotificationActivitySetting;
  } | {
    setting: 'channelsPersonalisedRecommendation';
    value: proto.SyncActionValue.IPrivacySettingChannelsPersonalisedRecommendationAction;
  };
};
type BufferedEventData = {
  historySets: {
    chats: {
      [jid: string]: Chat;
    };
    contacts: {
      [jid: string]: Contact;
    };
    messages: {
      [uqId: string]: WAMessage;
    };
    empty: boolean;
    isLatest: boolean;
    progress?: number | null;
    syncType?: proto.HistorySync.HistorySyncType;
    pastParticipants?: proto.IPastParticipants[];
    chunkOrder?: number | null;
    peerDataRequestSessionId?: string;
  };
  chatUpserts: {
    [jid: string]: Chat;
  };
  chatUpdates: {
    [jid: string]: ChatUpdate;
  };
  chatDeletes: Set<string>;
  contactUpserts: {
    [jid: string]: Contact;
  };
  contactUpdates: {
    [jid: string]: Partial<Contact>;
  };
  messageUpserts: {
    [key: string]: {
      type: MessageUpsertType;
      message: WAMessage;
    };
  };
  messageUpdates: {
    [key: string]: WAMessageUpdate;
  };
  messageDeletes: {
    [key: string]: WAMessageKey;
  };
  messageReactions: {
    [key: string]: {
      key: WAMessageKey;
      reactions: proto.IReaction[];
    };
  };
  messageReceipts: {
    [key: string]: {
      key: WAMessageKey;
      userReceipt: proto.IUserReceipt[];
    };
  };
  groupUpdates: {
    [jid: string]: Partial<GroupMetadata>;
  };
};
interface BaileysEventEmitter {
  on<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void;
  off<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void;
  removeAllListeners<T extends keyof BaileysEventMap>(event: T): void;
  emit<T extends keyof BaileysEventMap>(event: T, arg: BaileysEventMap[T]): boolean;
}
//#endregion
//#region node_modules/baileys/lib/Types/Chat.d.ts
/** privacy settings in WhatsApp Web */
type WAPrivacyValue = 'all' | 'contacts' | 'contact_blacklist' | 'none';
type WAPrivacyOnlineValue = 'all' | 'match_last_seen';
type WAPrivacyGroupAddValue = 'all' | 'contacts' | 'contact_blacklist';
type WAReadReceiptsValue = 'all' | 'none';
type WAPrivacyCallValue = 'all' | 'known';
type WAPrivacyMessagesValue = 'all' | 'contacts';
/** set of statuses visible to other people; see updatePresence() in WhatsAppWeb.Send */
type WAPresence = 'unavailable' | 'available' | 'composing' | 'recording' | 'paused';
declare const ALL_WA_PATCH_NAMES: readonly ["critical_block", "critical_unblock_low", "regular_high", "regular_low", "regular"];
type WAPatchName = (typeof ALL_WA_PATCH_NAMES)[number];
interface PresenceData {
  lastKnownPresence: WAPresence;
  lastSeen?: number;
}
type BotListInfo = {
  jid: string;
  personaId: string;
};
type WAPatchCreate = {
  syncAction: proto.ISyncActionValue;
  index: string[];
  type: WAPatchName;
  apiVersion: number;
  operation: proto.SyncdMutation.SyncdOperation;
};
type Chat = proto.IConversation & {
  /** unix timestamp of when the last message was received in the chat */lastMessageRecvTimestamp?: number;
};
type ChatUpdate = Partial<Chat & {
  /**
   * if specified in the update,
   * the EV buffer will check if the condition gets fulfilled before applying the update
   * Right now, used to determine when to release an app state sync event
   *
   * @returns true, if the update should be applied;
   * false if it can be discarded;
   * undefined if the condition is not yet fulfilled
   * */
  conditional: (bufferedData: BufferedEventData) => boolean | undefined; /** last update time */
  timestamp?: number;
}>;
/**
 * the last messages in a chat, sorted reverse-chronologically. That is, the latest message should be first in the chat
 * for MD modifications, the last message in the array (i.e. the earlist message) must be the last message recv in the chat
 * */
type LastMessageList = MinimalMessage[] | proto.SyncActionValue.ISyncActionMessageRange;
type ChatModification = {
  archive: boolean;
  lastMessages: LastMessageList;
} | {
  pushNameSetting: string;
} | {
  pin: boolean;
} | {
  /** mute for duration, or provide timestamp of mute to remove*/mute: number | null;
} | {
  clear: boolean;
  lastMessages: LastMessageList;
} | {
  deleteForMe: {
    deleteMedia: boolean;
    key: WAMessageKey;
    timestamp: number;
  };
} | {
  star: {
    messages: {
      id: string;
      fromMe?: boolean;
    }[];
    star: boolean;
  };
} | {
  markRead: boolean;
  lastMessages: LastMessageList;
} | {
  delete: true;
  lastMessages: LastMessageList;
} | {
  contact: proto.SyncActionValue.IContactAction | null;
} | {
  disableLinkPreviews: proto.SyncActionValue.IPrivacySettingDisableLinkPreviewsAction;
} | {
  addLabel: LabelActionBody;
} | {
  addChatLabel: ChatLabelAssociationActionBody;
} | {
  removeChatLabel: ChatLabelAssociationActionBody;
} | {
  addMessageLabel: MessageLabelAssociationActionBody;
} | {
  removeMessageLabel: MessageLabelAssociationActionBody;
} | {
  quickReply: QuickReplyAction;
};
//#endregion
//#region node_modules/baileys/lib/Types/Product.d.ts
type CatalogStatus = {
  status: string;
  canAppeal: boolean;
};
type CatalogCollection = {
  id: string;
  name: string;
  products: Product[];
  status: CatalogStatus;
};
type ProductAvailability = 'in stock';
type ProductBase = {
  name: string;
  retailerId?: string;
  url?: string;
  description: string;
  price: number;
  currency: string;
  isHidden?: boolean;
};
type ProductCreate = ProductBase & {
  /** ISO country code for product origin. Set to undefined for no country */originCountryCode: string | undefined; /** images of the product */
  images: WAMediaUpload[];
};
type ProductUpdate = Omit<ProductCreate, 'originCountryCode'>;
type Product = ProductBase & {
  id: string;
  imageUrls: {
    [_: string]: string;
  };
  reviewStatus: {
    [_: string]: string;
  };
  availability: ProductAvailability;
};
type OrderPrice = {
  currency: string;
  total: number;
};
type OrderProduct = {
  id: string;
  imageUrl: string;
  name: string;
  quantity: number;
  currency: string;
  price: number;
};
type OrderDetails = {
  price: OrderPrice;
  products: OrderProduct[];
};
type CatalogCursor = string;
type GetCatalogOptions = {
  /** cursor to start from */cursor?: CatalogCursor; /** number of products to fetch */
  limit?: number;
  jid?: string;
};
//#endregion
//#region node_modules/baileys/lib/Types/Mex.d.ts
type NewsletterUpdate = {
  name?: string;
  description?: string;
  picture?: string;
};
interface NewsletterMetadata {
  id: string;
  owner?: string;
  name: string;
  description?: string;
  invite?: string;
  creation_time?: number;
  subscribers?: number;
  picture?: {
    url?: string;
    directPath?: string;
    mediaKey?: string;
    id?: string;
  };
  verification?: 'VERIFIED' | 'UNVERIFIED';
  reaction_codes?: {
    code: string;
    count: number;
  }[];
  mute_state?: 'ON' | 'OFF';
  thread_metadata?: {
    creation_time?: number;
    name?: string;
    description?: string;
  };
}
//#endregion
//#region node_modules/baileys/lib/Types/index.d.ts
type UserFacingSocketConfig = Partial<SocketConfig> & {
  auth: AuthenticationState;
};
type WABusinessHoursConfig = {
  day_of_week: string;
  mode: string;
  open_time?: number;
  close_time?: number;
};
type WABusinessProfile = {
  description: string;
  email: string | undefined;
  business_hours: {
    timezone?: string;
    config?: WABusinessHoursConfig[];
    business_config?: WABusinessHoursConfig[];
  };
  website: string[];
  category?: string;
  wid?: string;
  address?: string;
};
//#endregion
//#region node_modules/baileys/lib/Socket/Client/types.d.ts
declare abstract class AbstractSocketClient extends EventEmitter$1 {
  url: URL;
  config: SocketConfig;
  abstract get isOpen(): boolean;
  abstract get isClosed(): boolean;
  abstract get isClosing(): boolean;
  abstract get isConnecting(): boolean;
  constructor(url: URL, config: SocketConfig);
  abstract connect(): void;
  abstract close(): void;
  abstract send(str: Uint8Array | string, cb?: (err?: Error) => void): boolean;
}
//#endregion
//#region node_modules/baileys/lib/Socket/Client/websocket.d.ts
declare class WebSocketClient extends AbstractSocketClient {
  protected socket: WebSocket | null;
  get isOpen(): boolean;
  get isClosed(): boolean;
  get isClosing(): boolean;
  get isConnecting(): boolean;
  connect(): void;
  close(): Promise<void>;
  send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean;
}
//#endregion
//#region node_modules/baileys/lib/Socket/index.d.ts
declare const makeWASocket: (config: UserFacingSocketConfig) => {
  communityMetadata: (jid: string) => Promise<GroupMetadata>;
  communityCreate: (subject: string, body: string) => Promise<GroupMetadata | null>;
  communityCreateGroup: (subject: string, participants: string[], parentCommunityJid: string) => Promise<GroupMetadata | null>;
  communityLeave: (id: string) => Promise<void>;
  communityUpdateSubject: (jid: string, subject: string) => Promise<void>;
  communityLinkGroup: (groupJid: string, parentCommunityJid: string) => Promise<void>;
  communityUnlinkGroup: (groupJid: string, parentCommunityJid: string) => Promise<void>;
  communityFetchLinkedGroups: (jid: string) => Promise<{
    communityJid: string;
    isCommunity: boolean;
    linkedGroups: {
      id: string | undefined;
      subject: string;
      creation: number | undefined;
      owner: string | undefined;
      size: number | undefined;
    }[];
  }>;
  communityRequestParticipantsList: (jid: string) => Promise<{
    [key: string]: string;
  }[]>;
  communityRequestParticipantsUpdate: (jid: string, participants: string[], action: "approve" | "reject") => Promise<{
    status: string;
    jid: string | undefined;
  }[]>;
  communityParticipantsUpdate: (jid: string, participants: string[], action: ParticipantAction) => Promise<{
    status: string;
    jid: string | undefined;
    content: BinaryNode;
  }[]>;
  communityUpdateDescription: (jid: string, description?: string) => Promise<void>;
  communityInviteCode: (jid: string) => Promise<string | undefined>;
  communityRevokeInvite: (jid: string) => Promise<string | undefined>;
  communityAcceptInvite: (code: string) => Promise<string | undefined>;
  communityRevokeInviteV4: (communityJid: string, invitedJid: string) => Promise<boolean>;
  communityAcceptInviteV4: (key: string | WAMessageKey, inviteMessage: proto.Message.IGroupInviteMessage) => Promise<any>;
  communityGetInviteInfo: (code: string) => Promise<GroupMetadata>;
  communityToggleEphemeral: (jid: string, ephemeralExpiration: number) => Promise<void>;
  communitySettingUpdate: (jid: string, setting: "announcement" | "not_announcement" | "locked" | "unlocked") => Promise<void>;
  communityMemberAddMode: (jid: string, mode: "admin_add" | "all_member_add") => Promise<void>;
  communityJoinApprovalMode: (jid: string, mode: "on" | "off") => Promise<void>;
  communityFetchAllParticipating: () => Promise<{
    [_: string]: GroupMetadata;
  }>;
  logger: ILogger;
  getOrderDetails: (orderId: string, tokenBase64: string) => Promise<OrderDetails>;
  getCatalog: ({
    jid,
    limit,
    cursor
  }: GetCatalogOptions) => Promise<{
    products: Product[];
    nextPageCursor: string | undefined;
  }>;
  getCollections: (jid?: string, limit?: number) => Promise<{
    collections: CatalogCollection[];
  }>;
  productCreate: (create: ProductCreate) => Promise<Product>;
  productDelete: (productIds: string[]) => Promise<{
    deleted: number;
  }>;
  productUpdate: (productId: string, update: ProductUpdate) => Promise<Product>;
  updateBussinesProfile: (args: UpdateBussinesProfileProps) => Promise<any>;
  updateCoverPhoto: (photo: WAMediaUpload) => Promise<number>;
  removeCoverPhoto: (id: string) => Promise<any>;
  sendMessageAck: (node: BinaryNode, errorCode?: number) => Promise<void>;
  sendRetryRequest: (node: BinaryNode, forceIncludeKeys?: boolean) => Promise<void>;
  rejectCall: (callId: string, callFrom: string) => Promise<void>;
  fetchMessageHistory: (count: number, oldestMsgKey: WAMessageKey, oldestMsgTimestamp: number | Long) => Promise<string>;
  requestPlaceholderResend: (messageKey: WAMessageKey, msgData?: Partial<WAMessage>) => Promise<string | undefined>;
  messageRetryManager: MessageRetryManager | null;
  userDevicesCache: PossiblyExtendedCacheStore | NodeCache<JidWithDevice[]>;
  devicesMutex: {
    mutex<T>(code: () => Promise<T> | T): Promise<T>;
  };
  issuePrivacyTokens: (jids: string[], timestamp?: number) => Promise<any>;
  assertSessions: (jids: string[], force?: boolean) => Promise<boolean>;
  relayMessage: (jid: string, message: proto.IMessage, {
    messageId: msgId,
    participant,
    additionalAttributes,
    additionalNodes,
    useUserDevicesCache,
    useCachedGroupMetadata,
    statusJidList
  }: MessageRelayOptions) => Promise<string>;
  sendReceipt: (jid: string, participant: string | undefined, messageIds: string[], type: MessageReceiptType) => Promise<void>;
  sendReceipts: (keys: WAMessageKey[], type: MessageReceiptType) => Promise<void>;
  readMessages: (keys: WAMessageKey[]) => Promise<void>;
  refreshMediaConn: (forceGet?: boolean) => Promise<MediaConnInfo>;
  getMediaHost: () => string;
  waUploadToServer: WAMediaUploadFunction;
  fetchPrivacySettings: (force?: boolean) => Promise<{
    [_: string]: string;
  }>;
  sendPeerDataOperationMessage: (pdoMessage: proto.Message.IPeerDataOperationRequestMessage) => Promise<string>;
  createParticipantNodes: (recipientJids: string[], message: proto.IMessage, extraAttrs?: BinaryNode["attrs"], dsmMessage?: proto.IMessage) => Promise<{
    nodes: BinaryNode[];
    shouldIncludeDeviceIdentity: boolean;
  }>;
  getUSyncDevices: (jids: string[], useCache: boolean, ignoreZeroDevices: boolean) => Promise<(JidWithDevice & {
    jid: string;
  })[]>;
  updateMemberLabel: (jid: string, memberLabel: string) => Promise<string>;
  updateMediaMessage: (message: WAMessage) => Promise<WAMessage>;
  sendMessage: (jid: string, content: AnyMessageContent, options?: MiscMessageGenerationOptions) => Promise<WAMessage | undefined>;
  newsletterCreate: (name: string, description?: string) => Promise<NewsletterMetadata>;
  newsletterUpdate: (jid: string, updates: NewsletterUpdate) => Promise<unknown>;
  newsletterSubscribers: (jid: string) => Promise<{
    subscribers: number;
  }>;
  newsletterMetadata: (type: "invite" | "jid", key: string) => Promise<NewsletterMetadata | null>;
  newsletterFollow: (jid: string) => Promise<unknown>;
  newsletterUnfollow: (jid: string) => Promise<unknown>;
  newsletterMute: (jid: string) => Promise<unknown>;
  newsletterUnmute: (jid: string) => Promise<unknown>;
  newsletterUpdateName: (jid: string, name: string) => Promise<unknown>;
  newsletterUpdateDescription: (jid: string, description: string) => Promise<unknown>;
  newsletterUpdatePicture: (jid: string, content: WAMediaUpload) => Promise<unknown>;
  newsletterRemovePicture: (jid: string) => Promise<unknown>;
  newsletterReactMessage: (jid: string, serverId: string, reaction?: string) => Promise<void>;
  newsletterFetchMessages: (jid: string, count: number, since: number, after: number) => Promise<any>;
  subscribeNewsletterUpdates: (jid: string) => Promise<{
    duration: string;
  } | null>;
  newsletterAdminCount: (jid: string) => Promise<number>;
  newsletterChangeOwner: (jid: string, newOwnerJid: string) => Promise<void>;
  newsletterDemote: (jid: string, userJid: string) => Promise<void>;
  newsletterDelete: (jid: string) => Promise<void>;
  groupMetadata: (jid: string) => Promise<GroupMetadata>;
  groupCreate: (subject: string, participants: string[]) => Promise<GroupMetadata>;
  groupLeave: (id: string) => Promise<void>;
  groupUpdateSubject: (jid: string, subject: string) => Promise<void>;
  groupRequestParticipantsList: (jid: string) => Promise<{
    [key: string]: string;
  }[]>;
  groupRequestParticipantsUpdate: (jid: string, participants: string[], action: "approve" | "reject") => Promise<{
    status: string;
    jid: string | undefined;
  }[]>;
  groupParticipantsUpdate: (jid: string, participants: string[], action: ParticipantAction) => Promise<{
    status: string;
    jid: string | undefined;
    content: BinaryNode;
  }[]>;
  groupUpdateDescription: (jid: string, description?: string) => Promise<void>;
  groupInviteCode: (jid: string) => Promise<string | undefined>;
  groupRevokeInvite: (jid: string) => Promise<string | undefined>;
  groupAcceptInvite: (code: string) => Promise<string | undefined>;
  groupRevokeInviteV4: (groupJid: string, invitedJid: string) => Promise<boolean>;
  groupAcceptInviteV4: (key: string | WAMessageKey, inviteMessage: proto.Message.IGroupInviteMessage) => Promise<any>;
  groupGetInviteInfo: (code: string) => Promise<GroupMetadata>;
  groupToggleEphemeral: (jid: string, ephemeralExpiration: number) => Promise<void>;
  groupSettingUpdate: (jid: string, setting: "announcement" | "not_announcement" | "locked" | "unlocked") => Promise<void>;
  groupMemberAddMode: (jid: string, mode: "admin_add" | "all_member_add") => Promise<void>;
  groupJoinApprovalMode: (jid: string, mode: "on" | "off") => Promise<void>;
  groupFetchAllParticipating: () => Promise<{
    [_: string]: GroupMetadata;
  }>;
  serverProps: {
    privacyTokenOn1to1: boolean;
    profilePicPrivacyToken: boolean;
    lidTrustedTokenIssueToLid: boolean;
  };
  createCallLink: (type: "audio" | "video", event?: {
    startTime: number;
  }, timeoutMs?: number) => Promise<string | undefined>;
  getBotListV2: () => Promise<BotListInfo[]>;
  messageMutex: {
    mutex<T>(code: () => Promise<T> | T): Promise<T>;
  };
  receiptMutex: {
    mutex<T>(code: () => Promise<T> | T): Promise<T>;
  };
  appStatePatchMutex: {
    mutex<T>(code: () => Promise<T> | T): Promise<T>;
  };
  notificationMutex: {
    mutex<T>(code: () => Promise<T> | T): Promise<T>;
  };
  upsertMessage: (msg: WAMessage, type: MessageUpsertType) => Promise<void>;
  appPatch: (patchCreate: WAPatchCreate) => Promise<void>;
  sendPresenceUpdate: (type: WAPresence, toJid?: string) => Promise<void>;
  presenceSubscribe: (toJid: string) => Promise<void>;
  profilePictureUrl: (jid: string, type?: "preview" | "image", timeoutMs?: number) => Promise<string | undefined>;
  fetchBlocklist: () => Promise<(string | undefined)[]>;
  fetchStatus: (...jids: string[]) => Promise<USyncQueryResultList[] | undefined>;
  fetchDisappearingDuration: (...jids: string[]) => Promise<USyncQueryResultList[] | undefined>;
  updateProfilePicture: (jid: string, content: WAMediaUpload, dimensions?: {
    width: number;
    height: number;
  }) => Promise<void>;
  removeProfilePicture: (jid: string) => Promise<void>;
  updateProfileStatus: (status: string) => Promise<void>;
  updateProfileName: (name: string) => Promise<void>;
  updateBlockStatus: (jid: string, action: "block" | "unblock") => Promise<void>;
  updateDisableLinkPreviewsPrivacy: (isPreviewsDisabled: boolean) => Promise<void>;
  updateCallPrivacy: (value: WAPrivacyCallValue) => Promise<void>;
  updateMessagesPrivacy: (value: WAPrivacyMessagesValue) => Promise<void>;
  updateLastSeenPrivacy: (value: WAPrivacyValue) => Promise<void>;
  updateOnlinePrivacy: (value: WAPrivacyOnlineValue) => Promise<void>;
  updateProfilePicturePrivacy: (value: WAPrivacyValue) => Promise<void>;
  updateStatusPrivacy: (value: WAPrivacyValue) => Promise<void>;
  updateReadReceiptsPrivacy: (value: WAReadReceiptsValue) => Promise<void>;
  updateGroupsAddPrivacy: (value: WAPrivacyGroupAddValue) => Promise<void>;
  updateDefaultDisappearingMode: (duration: number) => Promise<void>;
  getBusinessProfile: (jid: string) => Promise<WABusinessProfile | void>;
  resyncAppState: (collections: readonly ("critical_unblock_low" | "regular_high" | "regular_low" | "critical_block" | "regular")[], isInitialSync: boolean) => Promise<void>;
  chatModify: (mod: ChatModification, jid: string) => Promise<void>;
  cleanDirtyBits: (type: "account_sync" | "groups", fromTimestamp?: number | string) => Promise<void>;
  addOrEditContact: (jid: string, contact: proto.SyncActionValue.IContactAction) => Promise<void>;
  removeContact: (jid: string) => Promise<void>;
  placeholderResendCache: CacheStore;
  addLabel: (jid: string, labels: LabelActionBody) => Promise<void>;
  addChatLabel: (jid: string, labelId: string) => Promise<void>;
  removeChatLabel: (jid: string, labelId: string) => Promise<void>;
  addMessageLabel: (jid: string, messageId: string, labelId: string) => Promise<void>;
  removeMessageLabel: (jid: string, messageId: string, labelId: string) => Promise<void>;
  star: (jid: string, messages: {
    id: string;
    fromMe?: boolean;
  }[], star: boolean) => Promise<void>;
  addOrEditQuickReply: (quickReply: QuickReplyAction) => Promise<void>;
  removeQuickReply: (timestamp: string) => Promise<void>;
  type: "md";
  ws: WebSocketClient;
  ev: BaileysEventEmitter & {
    process(handler: (events: Partial<BaileysEventMap>) => void | Promise<void>): () => void;
    buffer(): void;
    createBufferedFunction<A extends any[], T>(work: (...args: A) => Promise<T>): (...args: A) => Promise<T>;
    flush(): boolean;
    isBuffering(): boolean;
    destroy(): void;
  };
  authState: {
    creds: AuthenticationCreds;
    keys: SignalKeyStoreWithTransaction;
  };
  signalRepository: SignalRepositoryWithLIDStore;
  user: Contact | undefined;
  generateMessageTag: () => string;
  query: (node: BinaryNode, timeoutMs?: number) => Promise<any>;
  waitForMessage: <T>(msgId: string, timeoutMs?: number | undefined) => Promise<T | undefined>;
  waitForSocketOpen: () => Promise<void>;
  sendRawMessage: (data: Uint8Array | Buffer) => Promise<void>;
  sendNode: (frame: BinaryNode) => Promise<void>;
  logout: (msg?: string) => Promise<void>;
  end: (error: Error | undefined) => Promise<void>;
  registerSocketEndHandler: (handler: (error: Error | undefined) => void | Promise<void>) => void;
  onUnexpectedError: (err: Error | Boom, msg: string) => void;
  uploadPreKeys: (count?: number) => Promise<void>;
  uploadPreKeysToServerIfRequired: () => Promise<void>;
  digestKeyBundle: () => Promise<void>;
  rotateSignedPreKey: () => Promise<void>;
  requestPairingCode: (phoneNumber: string, customPairingCode?: string) => Promise<string>;
  updateServerTimeOffset: ({
    attrs
  }: BinaryNode) => void;
  sendUnifiedSession: () => Promise<void>;
  wamBuffer: BinaryInfo;
  waitForConnectionUpdate: (check: (u: Partial<ConnectionState>) => Promise<boolean | undefined>, timeoutMs?: number) => Promise<void>;
  sendWAMBuffer: (wamBuffer: Buffer) => Promise<any>;
  executeUSyncQuery: (usyncQuery: USyncQuery) => Promise<USyncQueryResult | undefined>;
  onWhatsApp: (...phoneNumber: string[]) => Promise<{
    jid: string;
    exists: boolean;
  }[] | undefined>;
  fetchAccountReachoutTimelock: () => Promise<ReachoutTimelockState>;
  fetchNewChatMessageCap: () => Promise<NewChatMessageCapInfo>;
};
//#endregion
//#region node_modules/baileys/lib/Types/USync.d.ts
/**
 * Defines the interface for a USyncQuery protocol
 */
interface USyncQueryProtocol {
  /**
   * The name of the protocol
   */
  name: string;
  /**
   * Defines what goes inside the query part of a USyncQuery
   */
  getQueryElement: () => BinaryNode;
  /**
   * Defines what goes inside the user part of a USyncQuery
   */
  getUserElement: (user: USyncUser) => BinaryNode | null;
  /**
   * Parse the result of the query
   * @param data Data from the result
   * @returns Whatever the protocol is supposed to return
   */
  parser: (data: BinaryNode) => unknown;
}
//#endregion
//#region node_modules/baileys/lib/WAUSync/USyncUser.d.ts
declare class USyncUser {
  id?: string;
  lid?: string;
  phone?: string;
  username?: string;
  usernameKey?: string;
  type?: string;
  personaId?: string;
  withId(id: string): this;
  withLid(lid: string): this;
  withPhone(phone: string): this;
  withUsername(username: string): this;
  withUsernameKey(usernameKey: string): this;
  withType(type: string): this;
  withPersonaId(personaId: string): this;
}
//#endregion
//#region node_modules/baileys/lib/WAUSync/USyncQuery.d.ts
type USyncQueryResultList = {
  [protocol: string]: unknown;
  id: string;
};
type USyncQueryResult = {
  list: USyncQueryResultList[];
  sideList: USyncQueryResultList[];
};
declare class USyncQuery {
  protocols: USyncQueryProtocol[];
  users: USyncUser[];
  context: string;
  mode: string;
  constructor();
  withMode(mode: string): this;
  withContext(context: string): this;
  withUser(user: USyncUser): this;
  parseUSyncQueryResult(result: BinaryNode | undefined): USyncQueryResult | undefined;
  withDeviceProtocol(): this;
  withContactProtocol(): this;
  withStatusProtocol(): this;
  withDisappearingModeProtocol(): this;
  withBotProfileProtocol(): this;
  withLIDProtocol(): this;
  withUsernameProtocol(): this;
}
//#endregion
//#region node_modules/baileys/lib/Utils/message-retry-manager.d.ts
interface RecentMessage {
  message: proto.IMessage;
  timestamp: number;
}
declare enum RetryReason {
  UnknownError = 0,
  SignalErrorNoSession = 1,
  SignalErrorInvalidKey = 2,
  SignalErrorInvalidKeyId = 3,
  /** MAC verification failed - most common cause of decryption failures */
  SignalErrorInvalidMessage = 4,
  SignalErrorInvalidSignature = 5,
  SignalErrorFutureMessage = 6,
  /** Explicit MAC failure - session is definitely out of sync */
  SignalErrorBadMac = 7,
  SignalErrorInvalidSession = 8,
  SignalErrorInvalidMsgKey = 9,
  BadBroadcastEphemeralSetting = 10,
  UnknownCompanionNoPrekey = 11,
  AdvFailure = 12,
  StatusRevokeDelay = 13
}
declare class MessageRetryManager {
  private logger;
  private recentMessagesMap;
  private messageKeyIndex;
  private sessionRecreateHistory;
  private retryCounters;
  private baseKeys;
  private pendingPhoneRequests;
  private readonly maxMsgRetryCount;
  private statistics;
  constructor(logger: ILogger, maxMsgRetryCount: number);
  /**
   * Add a recent message to the cache for retry handling
   */
  addRecentMessage(to: string, id: string, message: proto.IMessage): void;
  /**
   * Get a recent message from the cache
   */
  getRecentMessage(to: string, id: string): RecentMessage | undefined;
  /**
   * Check if a session should be recreated based on retry count, history, and error code.
   * MAC errors (codes 4 and 7) trigger immediate session recreation regardless of timeout.
   */
  shouldRecreateSession(jid: string, hasSession: boolean, errorCode?: RetryReason): {
    reason: string;
    recreate: boolean;
  };
  /**
   * Parse error code from retry receipt's retry node.
   * Returns undefined if no error code is present.
   */
  parseRetryErrorCode(errorAttr: string | undefined): RetryReason | undefined;
  /**
   * Check if an error code indicates a MAC failure
   */
  isMacError(errorCode: RetryReason | undefined): boolean;
  /**
   * Increment retry counter for a message
   */
  incrementRetryCount(messageId: string): number;
  /**
   * Get retry count for a message
   */
  getRetryCount(messageId: string): number;
  /**
   * Check if message has exceeded maximum retry attempts
   */
  hasExceededMaxRetries(messageId: string): boolean;
  /**
   * Mark retry as successful
   */
  markRetrySuccess(messageId: string): void;
  /**
   * Mark retry as failed
   */
  markRetryFailed(messageId: string): void;
  /**
   * Schedule a phone request with delay
   */
  schedulePhoneRequest(messageId: string, callback: () => void, delay?: number): void;
  /**
   * Cancel pending phone request
   */
  cancelPendingPhoneRequest(messageId: string): void;
  clear(): void;
  saveBaseKey(addr: string, msgId: string, baseKey: Uint8Array): void;
  hasSameBaseKey(addr: string, msgId: string, baseKey: Uint8Array): boolean;
  deleteBaseKey(addr: string, msgId: string): void;
  private keyToString;
  private removeRecentMessage;
}
//#endregion
//#region node_modules/baileys/lib/WAM/constants.d.ts
type Event = {
  name: string;
  id: number;
  props: {
    [key: string]: [number, string | {
      [key: string]: number;
    }];
  };
  weight: number;
  wamChannel: string;
  privateStatsIdInt?: number;
};
type EventByName<T extends Event['name']> = Extract<Event, {
  name: T;
}>;
type EventInputType = { [key in Event['name']]: {
  props: { [k in keyof EventByName<key>['props']]: Value };
  globals: {
    [x: string]: Value;
  };
} } & {};
type Value = number | null | string;
//#endregion
//#region node_modules/baileys/lib/WAM/BinaryInfo.d.ts
declare class BinaryInfo {
  protocolVersion: number;
  sequence: number;
  events: EventInputType[];
  buffer: Buffer[];
  constructor(options?: Partial<BinaryInfo>);
}
//#endregion
//#region node_modules/baileys/lib/index.d.ts
type WASocket = ReturnType<typeof makeWASocket>;
//#endregion
//#region extensions/whatsapp/src/identity.d.ts
type WhatsAppIdentity = {
  jid?: string | null;
  lid?: string | null;
  e164?: string | null;
  name?: string | null;
  label?: string | null;
};
type WhatsAppSelfIdentity = {
  jid?: string | null;
  lid?: string | null;
  e164?: string | null;
};
type WhatsAppReplyContext = {
  id?: string;
  body: string;
  sender?: WhatsAppIdentity | null;
};
//#endregion
export { makeWASocket as a, WAMessageKey as c, WASocket as i, proto as l, WhatsAppReplyContext as n, AnyMessageContent as o, WhatsAppSelfIdentity as r, MiscMessageGenerationOptions as s, WhatsAppIdentity as t };