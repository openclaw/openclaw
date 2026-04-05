
####### Expanded from @PACKAGE_INIT@ by configure_package_config_file() #######
####### Any changes to this file will be overwritten by the next CMake run ####
####### The input file was ggml-config.cmake.in                            ########

get_filename_component(PACKAGE_PREFIX_DIR "${CMAKE_CURRENT_LIST_DIR}/../../../" ABSOLUTE)

macro(set_and_check _var _file)
  set(${_var} "${_file}")
  if(NOT EXISTS "${_file}")
    message(FATAL_ERROR "File or directory ${_file} referenced by variable ${_var} does not exist !")
  endif()
endmacro()

macro(check_required_components _NAME)
  foreach(comp ${${_NAME}_FIND_COMPONENTS})
    if(NOT ${_NAME}_${comp}_FOUND)
      if(${_NAME}_FIND_REQUIRED_${comp})
        set(${_NAME}_FOUND FALSE)
      endif()
    endif()
  endforeach()
endmacro()

####################################################################################


####### Expanded from @GGML_VARIABLES_EXPANED@ by configure_package_config_file() #######
####### Any changes to this file will be overwritten by the next CMake run        #######

set(GGML_ACCELERATE "ON")
set(GGML_ALL_WARNINGS "OFF")
set(GGML_ALL_WARNINGS_3RD_PARTY "OFF")
set(GGML_AMX_BF16 "OFF")
set(GGML_AMX_INT8 "OFF")
set(GGML_AMX_TILE "OFF")
set(GGML_AVAILABLE_BACKENDS "ggml-cpu-apple_m1;ggml-cpu-apple_m2_m3;ggml-cpu-apple_m4;ggml-blas;ggml-metal")
set(GGML_AVX "OFF")
set(GGML_AVX2 "OFF")
set(GGML_AVX512 "OFF")
set(GGML_AVX512_BF16 "OFF")
set(GGML_AVX512_VBMI "OFF")
set(GGML_AVX512_VNNI "OFF")
set(GGML_AVX_VNNI "OFF")
set(GGML_BACKEND_DIR "/opt/homebrew/Cellar/ggml/0.9.11/libexec")
set(GGML_BACKEND_DL "ON")
set(GGML_BLAS "ON")
set(GGML_BLAS_DEFAULT "ON")
set(GGML_BLAS_VENDOR "Apple")
set(GGML_BLAS_VENDOR_DEFAULT "Apple")
set(GGML_BMI2 "OFF")
set(GGML_BUILD_COMMIT "unknown")
set(GGML_BUILD_EXAMPLES "OFF")
set(GGML_BUILD_TESTS "OFF")
set(GGML_CCACHE "OFF")
set(GGML_COMPILER_SUPPORTS_FP16_FORMAT_I3E "")
set(GGML_CPU "ON")
set(GGML_CPU_ALL_VARIANTS "ON")
set(GGML_CPU_ARM_ARCH "")
set(GGML_CPU_HBM "OFF")
set(GGML_CPU_KLEIDIAI "OFF")
set(GGML_CPU_POWERPC_CPUTYPE "")
set(GGML_CPU_REPACK "ON")
set(GGML_CUDA "OFF")
set(GGML_CUDA_COMPRESSION_MODE "size")
set(GGML_CUDA_FA "ON")
set(GGML_CUDA_FA_ALL_QUANTS "OFF")
set(GGML_CUDA_FORCE_CUBLAS "OFF")
set(GGML_CUDA_FORCE_MMQ "OFF")
set(GGML_CUDA_GRAPHS "OFF")
set(GGML_CUDA_GRAPHS_DEFAULT "OFF")
set(GGML_CUDA_NO_PEER_COPY "OFF")
set(GGML_CUDA_NO_VMM "OFF")
set(GGML_CUDA_PEER_MAX_BATCH_SIZE "128")
set(GGML_F16C "OFF")
set(GGML_FATAL_WARNINGS "OFF")
set(GGML_FMA "OFF")
set(GGML_GIT_DIRTY "128")
set(GGML_GPROF "OFF")
set(GGML_HEXAGON "OFF")
set(GGML_HEXAGON_FP32_QUANTIZE_GROUP_SIZE "128")
set(GGML_HIP "OFF")
set(GGML_HIP_EXPORT_METRICS "OFF")
set(GGML_HIP_GRAPHS "OFF")
set(GGML_HIP_MMQ_MFMA "ON")
set(GGML_HIP_NO_VMM "ON")
set(GGML_HIP_ROCWMMA_FATTN "OFF")
set(GGML_LASX "ON")
set(GGML_LLAMAFILE "OFF")
set(GGML_LLAMAFILE_DEFAULT "OFF")
set(GGML_LSX "ON")
set(GGML_LTO "ON")
set(GGML_METAL "ON")
set(GGML_METAL_DEFAULT "ON")
set(GGML_METAL_EMBED_LIBRARY "ON")
set(GGML_METAL_MACOSX_VERSION_MIN "")
set(GGML_METAL_NDEBUG "OFF")
set(GGML_METAL_SHADER_DEBUG "OFF")
set(GGML_METAL_STD "")
set(GGML_MUSA "OFF")
set(GGML_MUSA_GRAPHS "OFF")
set(GGML_MUSA_MUDNN_COPY "OFF")
set(GGML_NATIVE "OFF")
set(GGML_NATIVE_DEFAULT "OFF")
set(GGML_OPENCL "OFF")
set(GGML_OPENCL_EMBED_KERNELS "ON")
set(GGML_OPENCL_PROFILING "OFF")
set(GGML_OPENCL_TARGET_VERSION "300")
set(GGML_OPENCL_USE_ADRENO_KERNELS "ON")
set(GGML_OPENMP "ON")
set(GGML_OPENMP_ENABLED "ON")
set(GGML_OPENVINO "OFF")
set(GGML_PUBLIC_HEADERS "include/ggml.h;include/ggml-cpu.h;include/ggml-alloc.h;include/ggml-backend.h;include/ggml-blas.h;include/ggml-cann.h;include/ggml-cpp.h;include/ggml-cuda.h;include/ggml-opt.h;include/ggml-metal.h;include/ggml-rpc.h;include/ggml-virtgpu.h;include/ggml-sycl.h;include/ggml-vulkan.h;include/ggml-webgpu.h;include/ggml-zendnn.h;include/ggml-openvino.h;include/gguf.h")
set(GGML_RPC "OFF")
set(GGML_RVV "ON")
set(GGML_RV_ZFH "ON")
set(GGML_RV_ZICBOP "ON")
set(GGML_RV_ZIHINTPAUSE "ON")
set(GGML_RV_ZVFBFWMA "OFF")
set(GGML_RV_ZVFH "ON")
set(GGML_SANITIZE_ADDRESS "OFF")
set(GGML_SANITIZE_THREAD "OFF")
set(GGML_SANITIZE_UNDEFINED "OFF")
set(GGML_SCHED_MAX_COPIES "4")
set(GGML_SCHED_NO_REALLOC "OFF")
set(GGML_SHARED_LIB "ON")
set(GGML_SSE42 "OFF")
set(GGML_STANDALONE "ON")
set(GGML_STATIC "OFF")
set(GGML_SYCL "OFF")
set(GGML_SYCL_DEVICE_ARCH "")
set(GGML_SYCL_DNN "ON")
set(GGML_SYCL_F16 "OFF")
set(GGML_SYCL_GRAPH "ON")
set(GGML_SYCL_TARGET "INTEL")
set(GGML_VERSION "0.9.11")
set(GGML_VERSION_BASE "0.9.11")
set(GGML_VERSION_MAJOR "0")
set(GGML_VERSION_MINOR "9")
set(GGML_VERSION_PATCH "11")
set(GGML_VIRTGPU "OFF")
set(GGML_VIRTGPU_BACKEND "OFF")
set(GGML_VULKAN "OFF")
set(GGML_VULKAN_CHECK_RESULTS "OFF")
set(GGML_VULKAN_DEBUG "OFF")
set(GGML_VULKAN_MEMORY_DEBUG "OFF")
set(GGML_VULKAN_RUN_TESTS "OFF")
set(GGML_VULKAN_SHADERS_GEN_TOOLCHAIN "")
set(GGML_VULKAN_SHADER_DEBUG_INFO "OFF")
set(GGML_VULKAN_VALIDATE "OFF")
set(GGML_VXE "OFF")
set(GGML_WEBGPU "OFF")
set(GGML_WEBGPU_CPU_PROFILE "OFF")
set(GGML_WEBGPU_DEBUG "OFF")
set(GGML_WEBGPU_GPU_PROFILE "OFF")
set(GGML_WEBGPU_JSPI "ON")
set(GGML_XTHEADVECTOR "OFF")
set(GGML_ZDNN "OFF")
set(GGML_ZENDNN "OFF")


# Find all dependencies before creating any target.
include(CMakeFindDependencyMacro)
find_dependency(Threads)
if (NOT GGML_SHARED_LIB)
    set(GGML_CPU_INTERFACE_LINK_LIBRARIES "")
    set(GGML_CPU_INTERFACE_LINK_OPTIONS   "")

    if (APPLE AND GGML_ACCELERATE)
        find_library(ACCELERATE_FRAMEWORK Accelerate)
        if(NOT ACCELERATE_FRAMEWORK)
            set(${CMAKE_FIND_PACKAGE_NAME}_FOUND 0)
            return()
        endif()
        list(APPEND GGML_CPU_INTERFACE_LINK_LIBRARIES ${ACCELERATE_FRAMEWORK})
    endif()

    if (GGML_OPENMP_ENABLED)
        find_dependency(OpenMP)
        list(APPEND GGML_CPU_INTERFACE_LINK_LIBRARIES OpenMP::OpenMP_C OpenMP::OpenMP_CXX)
    endif()

    if (GGML_CPU_HBM)
        find_library(memkind memkind)
        if(NOT memkind)
            set(${CMAKE_FIND_PACKAGE_NAME}_FOUND 0)
            return()
        endif()
        list(APPEND GGML_CPU_INTERFACE_LINK_LIBRARIES memkind)
    endif()

    if (GGML_BLAS)
        find_dependency(BLAS)
        list(APPEND GGML_BLAS_INTERFACE_LINK_LIBRARIES ${BLAS_LIBRARIES})
        list(APPEND GGML_BLAS_INTERFACE_LINK_OPTIONS   ${BLAS_LINKER_FLAGS})
    endif()

    if (GGML_CUDA)
        set(GGML_CUDA_INTERFACE_LINK_LIBRARIES "")
        find_dependency(CUDAToolkit)
        if (GGML_STATIC)
            list(APPEND GGML_CUDA_INTERFACE_LINK_LIBRARIES $<LINK_ONLY:CUDA::cudart_static>)
            if (WIN32)
                list(APPEND GGML_CUDA_INTERFACE_LINK_LIBRARIES $<LINK_ONLY:CUDA::cublas> $<LINK_ONLY:CUDA::cublasLt>)
            else()
                list(APPEND GGML_CUDA_INTERFACE_LINK_LIBRARIES $<LINK_ONLY:CUDA::cublas_static> $<LINK_ONLY:CUDA::cublasLt_static>)
            endif()
        endif()
        if (NOT GGML_CUDA_NO_VMM)
            list(APPEND GGML_CUDA_INTERFACE_LINK_LIBRARIES $<LINK_ONLY:CUDA::cuda_driver>)
        endif()
    endif()

    if (GGML_METAL)
        find_library(FOUNDATION_LIBRARY Foundation)
        find_library(METAL_FRAMEWORK    Metal)
        find_library(METALKIT_FRAMEWORK MetalKit)
        if(NOT FOUNDATION_LIBRARY OR NOT METAL_FRAMEWORK OR NOT METALKIT_FRAMEWORK)
            set(${CMAKE_FIND_PACKAGE_NAME}_FOUND 0)
            return()
        endif()
        set(GGML_METAL_INTERFACE_LINK_LIBRARIES
            ${FOUNDATION_LIBRARY} ${METAL_FRAMEWORK} ${METALKIT_FRAMEWORK})
    endif()

    if (GGML_OPENCL)
        find_dependency(OpenCL)
        set(GGML_OPENCL_INTERFACE_LINK_LIBRARIES $<LINK_ONLY:OpenCL::OpenCL>)
    endif()

    if (GGML_VULKAN)
        find_dependency(Vulkan)
        set(GGML_VULKAN_INTERFACE_LINK_LIBRARIES $<LINK_ONLY:Vulkan::Vulkan>)
    endif()

    if (GGML_HIP)
        find_dependency(hip)
        find_dependency(hipblas)
        find_dependency(rocblas)
        set(GGML_HIP_INTERFACE_LINK_LIBRARIES hip::host roc::rocblas roc::hipblas)
    endif()

    if (GGML_SYCL)
        set(GGML_SYCL_INTERFACE_LINK_LIBRARIES "")
        find_package(DNNL)
        if (${DNNL_FOUND} AND GGML_SYCL_TARGET STREQUAL "INTEL")
            list(APPEND GGML_SYCL_INTERFACE_LINK_LIBRARIES DNNL::dnnl)
        endif()
        if (WIN32)
            find_dependency(IntelSYCL)
            find_dependency(MKL)
            list(APPEND GGML_SYCL_INTERFACE_LINK_LIBRARIES IntelSYCL::SYCL_CXX MKL::MKL MKL::MKL_SYCL)
        endif()
    endif()
endif()

set_and_check(GGML_INCLUDE_DIR "${PACKAGE_PREFIX_DIR}/include")
set_and_check(GGML_LIB_DIR "${PACKAGE_PREFIX_DIR}/lib")
#set_and_check(GGML_BIN_DIR "${PACKAGE_PREFIX_DIR}/bin")

if(NOT TARGET ggml::ggml)
    find_package(Threads REQUIRED)

    find_library(GGML_LIBRARY ggml
        REQUIRED
        HINTS ${GGML_LIB_DIR}
        NO_CMAKE_FIND_ROOT_PATH)

    add_library(ggml::ggml UNKNOWN IMPORTED)
    set_target_properties(ggml::ggml
        PROPERTIES
            IMPORTED_LOCATION "${GGML_LIBRARY}")

    find_library(GGML_BASE_LIBRARY ggml-base
        REQUIRED
        HINTS ${GGML_LIB_DIR}
        NO_CMAKE_FIND_ROOT_PATH)

    add_library(ggml::ggml-base UNKNOWN IMPORTED)
    set_target_properties(ggml::ggml-base
        PROPERTIES
            IMPORTED_LOCATION "${GGML_BASE_LIBRARY}")

    set(_ggml_all_targets "")
    if (NOT GGML_BACKEND_DL)
        foreach(_ggml_backend ${GGML_AVAILABLE_BACKENDS})
            string(REPLACE "-" "_" _ggml_backend_pfx "${_ggml_backend}")
            string(TOUPPER "${_ggml_backend_pfx}" _ggml_backend_pfx)

            find_library(${_ggml_backend_pfx}_LIBRARY ${_ggml_backend}
                REQUIRED
                HINTS ${GGML_LIB_DIR}
                NO_CMAKE_FIND_ROOT_PATH)

            message(STATUS "Found ${${_ggml_backend_pfx}_LIBRARY}")

            add_library(ggml::${_ggml_backend} UNKNOWN IMPORTED)
            set_target_properties(ggml::${_ggml_backend}
                PROPERTIES
                    INTERFACE_INCLUDE_DIRECTORIES "${GGML_INCLUDE_DIR}"
                    IMPORTED_LINK_INTERFACE_LANGUAGES "CXX"
                    IMPORTED_LOCATION "${${_ggml_backend_pfx}_LIBRARY}"
                    INTERFACE_COMPILE_FEATURES c_std_90
                    POSITION_INDEPENDENT_CODE ON)

            string(REGEX MATCH "^ggml-cpu" is_cpu_variant "${_ggml_backend}")
            if(is_cpu_variant)
                list(APPEND GGML_CPU_INTERFACE_LINK_LIBRARIES "ggml::ggml-base")
                set_target_properties(ggml::${_ggml_backend}
                PROPERTIES
                    INTERFACE_LINK_LIBRARIES "${GGML_CPU_INTERFACE_LINK_LIBRARIES}")

                if(GGML_CPU_INTERFACE_LINK_OPTIONS)
                    set_target_properties(ggml::${_ggml_backend}
                        PROPERTIES
                            INTERFACE_LINK_OPTIONS "${GGML_CPU_INTERFACE_LINK_OPTIONS}")
                endif()

            else()
                list(APPEND ${_ggml_backend_pfx}_INTERFACE_LINK_LIBRARIES "ggml::ggml-base")
                set_target_properties(ggml::${_ggml_backend}
                    PROPERTIES
                        INTERFACE_LINK_LIBRARIES "${${_ggml_backend_pfx}_INTERFACE_LINK_LIBRARIES}")

                if(${_ggml_backend_pfx}_INTERFACE_LINK_OPTIONS)
                    set_target_properties(ggml::${_ggml_backend}
                        PROPERTIES
                            INTERFACE_LINK_OPTIONS "${${_ggml_backend_pfx}_INTERFACE_LINK_OPTIONS}")
                endif()
            endif()

            list(APPEND _ggml_all_targets ggml::${_ggml_backend})
        endforeach()
    endif()

    list(APPEND GGML_INTERFACE_LINK_LIBRARIES ggml::ggml-base "${_ggml_all_targets}")
    set_target_properties(ggml::ggml
        PROPERTIES
            INTERFACE_LINK_LIBRARIES "${GGML_INTERFACE_LINK_LIBRARIES}")

    add_library(ggml::all INTERFACE IMPORTED)
    set_target_properties(ggml::all
        PROPERTIES
            INTERFACE_LINK_LIBRARIES "${_ggml_all_targets}")

endif()

check_required_components(ggml)
