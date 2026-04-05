//===----------------------------------------------------------------------===//
//
// Part of the LLVM Project, under the Apache License v2.0 with LLVM Exceptions.
// See https://llvm.org/LICENSE.txt for license information.
// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception
//
//===----------------------------------------------------------------------===//

#ifndef __OMPX_H
#define __OMPX_H

#if (defined(__NVPTX__) || defined(__AMDGPU__))
#include <gpuintrin.h>
#define __OMPX_TARGET_IS_GPU
#endif

typedef unsigned long uint64_t;
typedef unsigned int uint32_t;

static inline uint32_t __warpSize(void) {
#ifdef __OMPX_TARGET_IS_GPU
  return __gpu_num_lanes();
#else
  __builtin_trap();
#endif
}

#ifdef __cplusplus
extern "C" {
#endif

int omp_get_ancestor_thread_num(int);
int omp_get_team_size(int);

#ifdef __cplusplus
}
#endif

/// Target kernel language extensions
///
/// These extensions exist for the host to allow fallback implementations,
/// however, they cannot be arbitrarily composed with OpenMP. If the rules of
/// the kernel language are followed, the host fallbacks should behave as
/// expected since the kernel is represented as 3 sequential outer loops, one
/// for each grid dimension, and three (nested) parallel loops, one for each
/// block dimension. This fallback is not supposed to be optimal and should be
/// configurable by the user.
///
///{

#ifdef __cplusplus
extern "C" {
#endif

enum {
  ompx_relaxed = __ATOMIC_RELAXED,
  ompx_aquire = __ATOMIC_ACQUIRE,
  ompx_release = __ATOMIC_RELEASE,
  ompx_acq_rel = __ATOMIC_ACQ_REL,
  ompx_seq_cst = __ATOMIC_SEQ_CST,
};

enum {
  ompx_dim_x = 0,
  ompx_dim_y = 1,
  ompx_dim_z = 2,
};

// TODO: The following implementation is for host fallback. We need to disable
// generation of host fallback in kernel language mode.
#pragma omp begin declare variant match(device = {kind(cpu)})

/// ompx_{thread,block}_{id,dim}
///{
#define _TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_C(NAME, VALUE)                     \
  static inline int ompx_##NAME(int Dim) { return VALUE; }

_TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_C(thread_id,
                                      omp_get_ancestor_thread_num(Dim + 1))
_TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_C(block_dim, omp_get_team_size(Dim + 1))
_TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_C(block_id, 0)
_TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_C(grid_dim, 1)
#undef _TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_C
///}

/// ompx_{sync_block}_{,divergent}
///{
#define _TGT_KERNEL_LANGUAGE_HOST_IMPL_SYNC_C(RETTY, NAME, ARGS, BODY)         \
  static inline RETTY ompx_##NAME(ARGS) { BODY; }

_TGT_KERNEL_LANGUAGE_HOST_IMPL_SYNC_C(void, sync_block, int Ordering,
                                      _Pragma("omp barrier"))
_TGT_KERNEL_LANGUAGE_HOST_IMPL_SYNC_C(void, sync_block_acq_rel, void,
                                      ompx_sync_block(ompx_acq_rel))
_TGT_KERNEL_LANGUAGE_HOST_IMPL_SYNC_C(void, sync_block_divergent, int Ordering,
                                      ompx_sync_block(Ordering))
#undef _TGT_KERNEL_LANGUAGE_HOST_IMPL_SYNC_C
///}

static inline uint64_t ompx_ballot_sync(uint64_t mask, int pred) {
  __builtin_trap();
}

/// ompx_shfl_down_sync_{i,f,l,d}
///{
#define _TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC_HOST_IMPL(TYPE, TY)                \
  static inline TYPE ompx_shfl_down_sync_##TY(uint64_t mask, TYPE var,         \
                                              unsigned delta, int width) {     \
    __builtin_trap();                                                          \
  }

_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC_HOST_IMPL(int, i)
_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC_HOST_IMPL(float, f)
_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC_HOST_IMPL(long, l)
_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC_HOST_IMPL(double, d)

#undef _TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC_HOST_IMPL
///}

#pragma omp end declare variant

/// ompx_{sync_block}_{,divergent}
///{
#define _TGT_KERNEL_LANGUAGE_DECL_SYNC_C(RETTY, NAME, ARGS)         \
  RETTY ompx_##NAME(ARGS);

_TGT_KERNEL_LANGUAGE_DECL_SYNC_C(void, sync_block, int Ordering)
_TGT_KERNEL_LANGUAGE_DECL_SYNC_C(void, sync_block_acq_rel, void)
_TGT_KERNEL_LANGUAGE_DECL_SYNC_C(void, sync_block_divergent, int Ordering)
#undef _TGT_KERNEL_LANGUAGE_DECL_SYNC_C
///}

/// ompx_{thread,block}_{id,dim}_{x,y,z}
///{
#define _TGT_KERNEL_LANGUAGE_DECL_GRID_C(NAME)                                 \
  int ompx_##NAME(int Dim);                                                    \
  static inline int ompx_##NAME##_x() { return ompx_##NAME(ompx_dim_x); }      \
  static inline int ompx_##NAME##_y() { return ompx_##NAME(ompx_dim_y); }      \
  static inline int ompx_##NAME##_z() { return ompx_##NAME(ompx_dim_z); }

_TGT_KERNEL_LANGUAGE_DECL_GRID_C(thread_id)
_TGT_KERNEL_LANGUAGE_DECL_GRID_C(block_dim)
_TGT_KERNEL_LANGUAGE_DECL_GRID_C(block_id)
_TGT_KERNEL_LANGUAGE_DECL_GRID_C(grid_dim)
#undef _TGT_KERNEL_LANGUAGE_DECL_GRID_C
///}

uint64_t ompx_ballot_sync(uint64_t mask, int pred);

/// ompx_shfl_down_sync_{i,f,l,d}
///{
#define _TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC(TYPE, TY)                          \
  TYPE ompx_shfl_down_sync_##TY(uint64_t mask, TYPE var, unsigned delta,       \
                                int width);

_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC(int, i)
_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC(float, f)
_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC(long, l)
_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC(double, d)

#undef _TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC
///}

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus

namespace ompx {

enum {
  dim_x = ompx_dim_x,
  dim_y = ompx_dim_y,
  dim_z = ompx_dim_z,
};

enum {
  relaxed = ompx_relaxed ,
  aquire = ompx_aquire,
  release = ompx_release,
  acc_rel = ompx_acq_rel,
  seq_cst = ompx_seq_cst,
};

/// ompx::{thread,block}_{id,dim}_{,x,y,z}
///{
#define _TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_CXX(NAME)                          \
  static inline int NAME(int Dim) noexcept { return ompx_##NAME(Dim); }        \
  static inline int NAME##_x() noexcept { return NAME(ompx_dim_x); }           \
  static inline int NAME##_y() noexcept { return NAME(ompx_dim_y); }           \
  static inline int NAME##_z() noexcept { return NAME(ompx_dim_z); }

_TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_CXX(thread_id)
_TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_CXX(block_dim)
_TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_CXX(block_id)
_TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_CXX(grid_dim)
#undef _TGT_KERNEL_LANGUAGE_HOST_IMPL_GRID_CXX
///}

/// ompx_{sync_block}_{,divergent}
///{
#define _TGT_KERNEL_LANGUAGE_HOST_IMPL_SYNC_CXX(RETTY, NAME, ARGS, CALL_ARGS)  \
  static inline RETTY NAME(ARGS) {               \
    return ompx_##NAME(CALL_ARGS);                                             \
  }

_TGT_KERNEL_LANGUAGE_HOST_IMPL_SYNC_CXX(void, sync_block, int Ordering = acc_rel,
                                        Ordering)
_TGT_KERNEL_LANGUAGE_HOST_IMPL_SYNC_CXX(void, sync_block_divergent,
                                        int Ordering = acc_rel, Ordering)
#undef _TGT_KERNEL_LANGUAGE_HOST_IMPL_SYNC_CXX
///}

static inline uint64_t ballot_sync(uint64_t mask, int pred) {
  return ompx_ballot_sync(mask, pred);
}

/// shfl_down_sync
///{
#define _TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC(TYPE, TY)                          \
  static inline TYPE shfl_down_sync(uint64_t mask, TYPE var, unsigned delta,   \
                                    int width = __warpSize()) {                \
    return ompx_shfl_down_sync_##TY(mask, var, delta, width);                  \
  }

_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC(int, i)
_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC(float, f)
_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC(long, l)
_TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC(double, d)

#undef _TGT_KERNEL_LANGUAGE_SHFL_DOWN_SYNC
///}

} // namespace ompx
#endif

///}

#endif /* __OMPX_H */
