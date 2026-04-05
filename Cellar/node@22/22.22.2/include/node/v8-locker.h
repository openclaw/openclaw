// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_LOCKER_H_
#define INCLUDE_V8_LOCKER_H_

#include "v8config.h"  // NOLINT(build/include_directory)

namespace v8 {

namespace internal {
class Isolate;
}  // namespace internal

class Isolate;

/**
 * Multiple threads in V8 are allowed, but only one thread at a time is allowed
 * to use any given V8 isolate, see the comments in the Isolate class. The
 * definition of 'using a V8 isolate' includes accessing handles or holding onto
 * object pointers obtained from V8 handles while in the particular V8 isolate.
 * It is up to the user of V8 to ensure, perhaps with locking, that this
 * constraint is not violated. In addition to any other synchronization
 * mechanism that may be used, the v8::Locker and v8::Unlocker classes must be
 * used to signal thread switches to V8.
 *
 * v8::Locker is a scoped lock object. While it's active, i.e. between its
 * construction and destruction, the current thread is allowed to use the locked
 * isolate. V8 guarantees that an isolate can be locked by at most one thread at
 * any time. In other words, the scope of a v8::Locker is a critical section.
 *
 * Sample usage:
 * \code
 * ...
 * {
 *   v8::Locker locker(isolate);
 *   v8::Isolate::Scope isolate_scope(isolate);
 *   ...
 *   // Code using V8 and isolate goes here.
 *   ...
 * } // Destructor called here
 * \endcode
 *
 * If you wish to stop using V8 in a thread A you can do this either by
 * destroying the v8::Locker object as above or by constructing a v8::Unlocker
 * object:
 *
 * \code
 * {
 *   isolate->Exit();
 *   v8::Unlocker unlocker(isolate);
 *   ...
 *   // Code not using V8 goes here while V8 can run in another thread.
 *   ...
 * } // Destructor called here.
 * isolate->Enter();
 * \endcode
 *
 * The Unlocker object is intended for use in a long-running callback from V8,
 * where you want to release the V8 lock for other threads to use.
 *
 * The v8::Locker is a recursive lock, i.e. you can lock more than once in a
 * given thread. This can be useful if you have code that can be called either
 * from code that holds the lock or from code that does not. The Unlocker is
 * not recursive so you can not have several Unlockers on the stack at once, and
 * you cannot use an Unlocker in a thread that is not inside a Locker's scope.
 *
 * An unlocker will unlock several lockers if it has to and reinstate the
 * correct depth of locking on its destruction, e.g.:
 *
 * \code
 * // V8 not locked.
 * {
 *   v8::Locker locker(isolate);
 *   Isolate::Scope isolate_scope(isolate);
 *   // V8 locked.
 *   {
 *     v8::Locker another_locker(isolate);
 *     // V8 still locked (2 levels).
 *     {
 *       isolate->Exit();
 *       v8::Unlocker unlocker(isolate);
 *       // V8 not locked.
 *     }
 *     isolate->Enter();
 *     // V8 locked again (2 levels).
 *   }
 *   // V8 still locked (1 level).
 * }
 * // V8 Now no longer locked.
 * \endcode
 */
class V8_EXPORT Unlocker {
 public:
  /**
   * Initialize Unlocker for a given Isolate.
   */
  V8_INLINE explicit Unlocker(Isolate* isolate) { Initialize(isolate); }

  ~Unlocker();

 private:
  void Initialize(Isolate* isolate);

  internal::Isolate* isolate_;
};

class V8_EXPORT Locker {
 public:
  /**
   * Initialize Locker for a given Isolate.
   */
  V8_INLINE explicit Locker(Isolate* isolate) { Initialize(isolate); }

  ~Locker();

  /**
   * Returns whether or not the locker for a given isolate, is locked by the
   * current thread.
   */
  static bool IsLocked(Isolate* isolate);

  // Disallow copying and assigning.
  Locker(const Locker&) = delete;
  void operator=(const Locker&) = delete;

 private:
  void Initialize(Isolate* isolate);

  bool has_lock_;
  bool top_level_;
  internal::Isolate* isolate_;
};

}  // namespace v8

#endif  // INCLUDE_V8_LOCKER_H_
