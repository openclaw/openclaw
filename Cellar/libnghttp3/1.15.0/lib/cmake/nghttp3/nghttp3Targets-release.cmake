#----------------------------------------------------------------
# Generated CMake target import file for configuration "Release".
#----------------------------------------------------------------

# Commands may need to know the format version.
set(CMAKE_IMPORT_FILE_VERSION 1)

# Import target "nghttp3::nghttp3" for configuration "Release"
set_property(TARGET nghttp3::nghttp3 APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(nghttp3::nghttp3 PROPERTIES
  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/lib/libnghttp3.9.6.1.dylib"
  IMPORTED_SONAME_RELEASE "@rpath/libnghttp3.9.dylib"
  )

list(APPEND _cmake_import_check_targets nghttp3::nghttp3 )
list(APPEND _cmake_import_check_files_for_nghttp3::nghttp3 "${_IMPORT_PREFIX}/lib/libnghttp3.9.6.1.dylib" )

# Import target "nghttp3::nghttp3_static" for configuration "Release"
set_property(TARGET nghttp3::nghttp3_static APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(nghttp3::nghttp3_static PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_RELEASE "C"
  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/lib/libnghttp3.a"
  )

list(APPEND _cmake_import_check_targets nghttp3::nghttp3_static )
list(APPEND _cmake_import_check_files_for_nghttp3::nghttp3_static "${_IMPORT_PREFIX}/lib/libnghttp3.a" )

# Commands beyond this point should not need to know the version.
set(CMAKE_IMPORT_FILE_VERSION)
