#ifndef SIMDUTF_AVX512_H_
#define SIMDUTF_AVX512_H_

/*
    It's possible to override AVX512 settings with cmake DCMAKE_CXX_FLAGS.

    All preprocessor directives has form `SIMDUTF_HAS_AVX512{feature}`,
    where a feature is a code name for extensions.

    Please see the listing below to find which are supported.
*/

#ifndef SIMDUTF_HAS_AVX512F
  #if defined(__AVX512F__) && __AVX512F__ == 1
    #define SIMDUTF_HAS_AVX512F 1
  #endif
#endif

#ifndef SIMDUTF_HAS_AVX512DQ
  #if defined(__AVX512DQ__) && __AVX512DQ__ == 1
    #define SIMDUTF_HAS_AVX512DQ 1
  #endif
#endif

#ifndef SIMDUTF_HAS_AVX512IFMA
  #if defined(__AVX512IFMA__) && __AVX512IFMA__ == 1
    #define SIMDUTF_HAS_AVX512IFMA 1
  #endif
#endif

#ifndef SIMDUTF_HAS_AVX512CD
  #if defined(__AVX512CD__) && __AVX512CD__ == 1
    #define SIMDUTF_HAS_AVX512CD 1
  #endif
#endif

#ifndef SIMDUTF_HAS_AVX512BW
  #if defined(__AVX512BW__) && __AVX512BW__ == 1
    #define SIMDUTF_HAS_AVX512BW 1
  #endif
#endif

#ifndef SIMDUTF_HAS_AVX512VL
  #if defined(__AVX512VL__) && __AVX512VL__ == 1
    #define SIMDUTF_HAS_AVX512VL 1
  #endif
#endif

#ifndef SIMDUTF_HAS_AVX512VBMI
  #if defined(__AVX512VBMI__) && __AVX512VBMI__ == 1
    #define SIMDUTF_HAS_AVX512VBMI 1
  #endif
#endif

#ifndef SIMDUTF_HAS_AVX512VBMI2
  #if defined(__AVX512VBMI2__) && __AVX512VBMI2__ == 1
    #define SIMDUTF_HAS_AVX512VBMI2 1
  #endif
#endif

#ifndef SIMDUTF_HAS_AVX512VNNI
  #if defined(__AVX512VNNI__) && __AVX512VNNI__ == 1
    #define SIMDUTF_HAS_AVX512VNNI 1
  #endif
#endif

#ifndef SIMDUTF_HAS_AVX512BITALG
  #if defined(__AVX512BITALG__) && __AVX512BITALG__ == 1
    #define SIMDUTF_HAS_AVX512BITALG 1
  #endif
#endif

#ifndef SIMDUTF_HAS_AVX512VPOPCNTDQ
  #if defined(__AVX512VPOPCNTDQ__) && __AVX512VPOPCNTDQ__ == 1
    #define SIMDUTF_HAS_AVX512VPOPCNTDQ 1
  #endif
#endif

#endif // SIMDUTF_AVX512_H_
