
####### Expanded from @PACKAGE_INIT@ by configure_package_config_file() #######
####### Any changes to this file will be overwritten by the next CMake run ####
####### The input file was config.cmake.in                            ########

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

if(EXISTS ${CMAKE_CURRENT_LIST_DIR}/SVT-AV1-staticTargets.cmake)
    if(UNIX AND NOT APPLE)
        include(CMakeFindDependencyMacro)
        find_dependency(Threads)
    endif()
    include(${CMAKE_CURRENT_LIST_DIR}/SVT-AV1-staticTargets.cmake)
endif()

if(EXISTS ${CMAKE_CURRENT_LIST_DIR}/SVT-AV1-sharedTargets.cmake)
    include(${CMAKE_CURRENT_LIST_DIR}/SVT-AV1-sharedTargets.cmake)
    add_library(SVT-AV1::SVT-AV1 ALIAS SVT-AV1::SVT-AV1-shared)
else()
    add_library(SVT-AV1::SVT-AV1 ALIAS SVT-AV1::SVT-AV1-static)
endif()

set_and_check(SVT-AV1_INCLUDE_DIR "${PACKAGE_PREFIX_DIR}/include")
set_and_check(SVT-AV1_LIB_DIR "${PACKAGE_PREFIX_DIR}/lib")

check_required_components(SVT-AV1)
