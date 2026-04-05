#----------------------------------------------------------------
# Generated CMake target import file for configuration "Release".
#----------------------------------------------------------------

# Commands may need to know the format version.
set(CMAKE_IMPORT_FILE_VERSION 1)

# Import target "uvwasi::uvwasi_a" for configuration "Release"
set_property(TARGET uvwasi::uvwasi_a APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(uvwasi::uvwasi_a PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_RELEASE "C"
  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/lib/libuvwasi.a"
  )

list(APPEND _cmake_import_check_targets uvwasi::uvwasi_a )
list(APPEND _cmake_import_check_files_for_uvwasi::uvwasi_a "${_IMPORT_PREFIX}/lib/libuvwasi.a" )

# Import target "uvwasi::uvwasi" for configuration "Release"
set_property(TARGET uvwasi::uvwasi APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(uvwasi::uvwasi PROPERTIES
  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/lib/libuvwasi.dylib"
  IMPORTED_SONAME_RELEASE "@rpath/libuvwasi.dylib"
  )

list(APPEND _cmake_import_check_targets uvwasi::uvwasi )
list(APPEND _cmake_import_check_files_for_uvwasi::uvwasi "${_IMPORT_PREFIX}/lib/libuvwasi.dylib" )

# Commands beyond this point should not need to know the version.
set(CMAKE_IMPORT_FILE_VERSION)
