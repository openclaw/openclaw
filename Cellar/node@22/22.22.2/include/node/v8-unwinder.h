// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_UNWINDER_H_
#define INCLUDE_V8_UNWINDER_H_

#include <memory>

#include "v8-embedder-state-scope.h"  // NOLINT(build/include_directory)
#include "v8config.h"                 // NOLINT(build/include_directory)

namespace v8 {
// Holds the callee saved registers needed for the stack unwinder. It is the
// empty struct if no registers are required. Implemented in
// include/v8-unwinder-state.h.
struct CalleeSavedRegisters;

// A RegisterState represents the current state of registers used
// by the sampling profiler API.
struct V8_EXPORT RegisterState {
  RegisterState();
  ~RegisterState();
  RegisterState(const RegisterState& other);
  RegisterState& operator=(const RegisterState& other);

  void* pc;  // Instruction pointer.
  void* sp;  // Stack pointer.
  void* fp;  // Frame pointer.
  void* lr;  // Link register (or nullptr on platforms without a link register).
  // Callee saved registers (or null if no callee saved registers were stored)
  std::unique_ptr<CalleeSavedRegisters> callee_saved;
};

// A StateTag represents a possible state of the VM.
enum StateTag : uint16_t {
  JS,
  GC,
  PARSER,
  BYTECODE_COMPILER,
  COMPILER,
  OTHER,
  EXTERNAL,
  ATOMICS_WAIT,
  IDLE
};

// The output structure filled up by GetStackSample API function.
struct SampleInfo {
  size_t frames_count;              // Number of frames collected.
  void* external_callback_entry;    // External callback address if VM is
                                    // executing an external callback.
  void* context;                    // Incumbent native context address.
  void* embedder_context;           // Native context address for embedder state
  StateTag vm_state;                // Current VM state.
  EmbedderStateTag embedder_state;  // Current Embedder state
};

struct MemoryRange {
  const void* start = nullptr;
  size_t length_in_bytes = 0;
};

struct JSEntryStub {
  MemoryRange code;
};

struct JSEntryStubs {
  JSEntryStub js_entry_stub;
  JSEntryStub js_construct_entry_stub;
  JSEntryStub js_run_microtasks_entry_stub;
};

/**
 * Various helpers for skipping over V8 frames in a given stack.
 *
 * The unwinder API is only supported on the x64, ARM64 and ARM32 architectures.
 */
class V8_EXPORT Unwinder {
 public:
  /**
   * Attempt to unwind the stack to the most recent C++ frame. This function is
   * signal-safe and does not access any V8 state and thus doesn't require an
   * Isolate.
   *
   * The unwinder needs to know the location of the JS Entry Stub (a piece of
   * code that is run when C++ code calls into generated JS code). This is used
   * for edge cases where the current frame is being constructed or torn down
   * when the stack sample occurs.
   *
   * The unwinder also needs the virtual memory range of all possible V8 code
   * objects. There are two ranges required - the heap code range and the range
   * for code embedded in the binary.
   *
   * Available on x64, ARM64 and ARM32.
   *
   * \param code_pages A list of all of the ranges in which V8 has allocated
   * executable code. The caller should obtain this list by calling
   * Isolate::CopyCodePages() during the same interrupt/thread suspension that
   * captures the stack.
   * \param register_state The current registers. This is an in-out param that
   * will be overwritten with the register values after unwinding, on success.
   * \param stack_base The resulting stack pointer and frame pointer values are
   * bounds-checked against the stack_base and the original stack pointer value
   * to ensure that they are valid locations in the given stack. If these values
   * or any intermediate frame pointer values used during unwinding are ever out
   * of these bounds, unwinding will fail.
   *
   * \return True on success.
   */
  static bool TryUnwindV8Frames(const JSEntryStubs& entry_stubs,
                                size_t code_pages_length,
                                const MemoryRange* code_pages,
                                RegisterState* register_state,
                                const void* stack_base);

  /**
   * Whether the PC is within the V8 code range represented by code_pages.
   *
   * If this returns false, then calling UnwindV8Frames() with the same PC
   * and unwind_state will always fail. If it returns true, then unwinding may
   * (but not necessarily) be successful.
   *
   * Available on x64, ARM64 and ARM32
   */
  static bool PCIsInV8(size_t code_pages_length, const MemoryRange* code_pages,
                       void* pc);
};

}  // namespace v8

#endif  // INCLUDE_V8_UNWINDER_H_
