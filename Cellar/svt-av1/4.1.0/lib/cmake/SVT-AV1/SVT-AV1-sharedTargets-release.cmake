#----------------------------------------------------------------
# Generated CMake target import file for configuration "Release".
#----------------------------------------------------------------

# Commands may need to know the format version.
set(CMAKE_IMPORT_FILE_VERSION 1)

# Import target "SVT-AV1::SVT-AV1-shared" for configuration "Release"
set_property(TARGET SVT-AV1::SVT-AV1-shared APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(SVT-AV1::SVT-AV1-shared PROPERTIES
  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/lib/libSvtAv1Enc.4.1.0.dylib"
  IMPORTED_SONAME_RELEASE "@rpath/libSvtAv1Enc.4.dylib"
  )

list(APPEND _cmake_import_check_targets SVT-AV1::SVT-AV1-shared )
list(APPEND _cmake_import_check_files_for_SVT-AV1::SVT-AV1-shared "${_IMPORT_PREFIX}/lib/libSvtAv1Enc.4.1.0.dylib" )

# Commands beyond this point should not need to know the version.
set(CMAKE_IMPORT_FILE_VERSION)
