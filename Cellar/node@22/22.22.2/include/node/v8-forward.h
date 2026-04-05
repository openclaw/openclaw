// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_FORWARD_H_
#define INCLUDE_V8_FORWARD_H_

// This header is intended to be used by headers that pass around V8 types,
// either by pointer or using Local<Type>. The full definitions can be included
// either via v8.h or the more fine-grained headers.

#include "v8-local-handle.h"  // NOLINT(build/include_directory)

namespace v8 {

class AccessorSignature;
class Array;
class ArrayBuffer;
class ArrayBufferView;
class BigInt;
class BigInt64Array;
class BigIntObject;
class BigUint64Array;
class Boolean;
class BooleanObject;
class Context;
class DataView;
class Data;
class Date;
class DictionaryTemplate;
class Extension;
class External;
class FixedArray;
class Float32Array;
class Float64Array;
class Function;
template <class F>
class FunctionCallbackInfo;
class FunctionTemplate;
class Int16Array;
class Int32;
class Int32Array;
class Int8Array;
class Integer;
class Isolate;
class Map;
class Module;
class Name;
class Number;
class NumberObject;
class Object;
class ObjectTemplate;
class Platform;
class Primitive;
class Private;
class Promise;
class Proxy;
class RegExp;
class Script;
class Set;
class SharedArrayBuffer;
class Signature;
class String;
class StringObject;
class Symbol;
class SymbolObject;
class Template;
class TryCatch;
class TypedArray;
class Uint16Array;
class Uint32;
class Uint32Array;
class Uint8Array;
class Uint8ClampedArray;
class UnboundModuleScript;
class Value;
class WasmMemoryObject;
class WasmModuleObject;

}  // namespace v8

#endif  // INCLUDE_V8_FORWARD_H_
