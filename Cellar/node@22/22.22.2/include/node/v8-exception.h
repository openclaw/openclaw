// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_EXCEPTION_H_
#define INCLUDE_V8_EXCEPTION_H_

#include <stddef.h>

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Context;
class Isolate;
class Message;
class StackTrace;
class String;
class Value;

namespace internal {
class Isolate;
class ThreadLocalTop;
}  // namespace internal

/**
 * Create new error objects by calling the corresponding error object
 * constructor with the message.
 */
class V8_EXPORT Exception {
 public:
  static Local<Value> RangeError(Local<String> message,
                                 Local<Value> options = {});
  static Local<Value> ReferenceError(Local<String> message,
                                     Local<Value> options = {});
  static Local<Value> SyntaxError(Local<String> message,
                                  Local<Value> options = {});
  static Local<Value> TypeError(Local<String> message,
                                Local<Value> options = {});
  static Local<Value> WasmCompileError(Local<String> message,
                                       Local<Value> options = {});
  static Local<Value> WasmLinkError(Local<String> message,
                                    Local<Value> options = {});
  static Local<Value> WasmRuntimeError(Local<String> message,
                                       Local<Value> options = {});
  static Local<Value> Error(Local<String> message, Local<Value> options = {});

  /**
   * Creates an error message for the given exception.
   * Will try to reconstruct the original stack trace from the exception value,
   * or capture the current stack trace if not available.
   */
  static Local<Message> CreateMessage(Isolate* isolate, Local<Value> exception);

  /**
   * Returns the original stack trace that was captured at the creation time
   * of a given exception, or an empty handle if not available.
   */
  static Local<StackTrace> GetStackTrace(Local<Value> exception);
};

/**
 * An external exception handler.
 */
class V8_EXPORT TryCatch {
 public:
  /**
   * Creates a new try/catch block and registers it with v8.  Note that
   * all TryCatch blocks should be stack allocated because the memory
   * location itself is compared against JavaScript try/catch blocks.
   */
  explicit TryCatch(Isolate* isolate);

  /**
   * Unregisters and deletes this try/catch block.
   */
  ~TryCatch();

  /**
   * Returns true if an exception has been caught by this try/catch block.
   */
  bool HasCaught() const;

  /**
   * For certain types of exceptions, it makes no sense to continue execution.
   *
   * If CanContinue returns false, the correct action is to perform any C++
   * cleanup needed and then return.  If CanContinue returns false and
   * HasTerminated returns true, it is possible to call
   * CancelTerminateExecution in order to continue calling into the engine.
   */
  bool CanContinue() const;

  /**
   * Returns true if an exception has been caught due to script execution
   * being terminated.
   *
   * There is no JavaScript representation of an execution termination
   * exception.  Such exceptions are thrown when the TerminateExecution
   * methods are called to terminate a long-running script.
   *
   * If such an exception has been thrown, HasTerminated will return true,
   * indicating that it is possible to call CancelTerminateExecution in order
   * to continue calling into the engine.
   */
  bool HasTerminated() const;

  /**
   * Throws the exception caught by this TryCatch in a way that avoids
   * it being caught again by this same TryCatch.  As with ThrowException
   * it is illegal to execute any JavaScript operations after calling
   * ReThrow; the caller must return immediately to where the exception
   * is caught.
   */
  Local<Value> ReThrow();

  /**
   * Returns the exception caught by this try/catch block.  If no exception has
   * been caught an empty handle is returned.
   */
  Local<Value> Exception() const;

  /**
   * Returns the .stack property of an object.  If no .stack
   * property is present an empty handle is returned.
   */
  V8_WARN_UNUSED_RESULT static MaybeLocal<Value> StackTrace(
      Local<Context> context, Local<Value> exception);

  /**
   * Returns the .stack property of the thrown object.  If no .stack property is
   * present or if this try/catch block has not caught an exception, an empty
   * handle is returned.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Value> StackTrace(
      Local<Context> context) const;

  /**
   * Returns the message associated with this exception.  If there is
   * no message associated an empty handle is returned.
   */
  Local<v8::Message> Message() const;

  /**
   * Clears any exceptions that may have been caught by this try/catch block.
   * After this method has been called, HasCaught() will return false. Cancels
   * the scheduled exception if it is caught and ReThrow() is not called before.
   *
   * It is not necessary to clear a try/catch block before using it again; if
   * another exception is thrown the previously caught exception will just be
   * overwritten.  However, it is often a good idea since it makes it easier
   * to determine which operation threw a given exception.
   */
  void Reset();

  /**
   * Set verbosity of the external exception handler.
   *
   * By default, exceptions that are caught by an external exception
   * handler are not reported.  Call SetVerbose with true on an
   * external exception handler to have exceptions caught by the
   * handler reported as if they were not caught.
   */
  void SetVerbose(bool value);

  /**
   * Returns true if verbosity is enabled.
   */
  bool IsVerbose() const;

  /**
   * Set whether or not this TryCatch should capture a Message object
   * which holds source information about where the exception
   * occurred.  True by default.
   */
  void SetCaptureMessage(bool value);

  TryCatch(const TryCatch&) = delete;
  void operator=(const TryCatch&) = delete;

 private:
  // Declaring operator new and delete as deleted is not spec compliant.
  // Therefore declare them private instead to disable dynamic alloc
  void* operator new(size_t size);
  void* operator new[](size_t size);
  void operator delete(void*, size_t);
  void operator delete[](void*, size_t);

  /**
   * There are cases when the raw address of C++ TryCatch object cannot be
   * used for comparisons with addresses into the JS stack. The cases are:
   * 1) ARM, ARM64 and MIPS simulators which have separate JS stack.
   * 2) Address sanitizer allocates local C++ object in the heap when
   *    UseAfterReturn mode is enabled.
   * This method returns address that can be used for comparisons with
   * addresses into the JS stack. When neither simulator nor ASAN's
   * UseAfterReturn is enabled, then the address returned will be the address
   * of the C++ try catch handler itself.
   */
  internal::Address JSStackComparableAddressPrivate() {
    return js_stack_comparable_address_;
  }

  void ResetInternal();

  internal::Isolate* i_isolate_;
  TryCatch* next_;
  void* exception_;
  void* message_obj_;
  internal::Address js_stack_comparable_address_;
  bool is_verbose_ : 1;
  bool can_continue_ : 1;
  bool capture_message_ : 1;
  bool rethrow_ : 1;

  friend class internal::Isolate;
  friend class internal::ThreadLocalTop;
};

}  // namespace v8

#endif  // INCLUDE_V8_EXCEPTION_H_
