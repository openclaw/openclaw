# Copyright (C) The c-ares project and its contributors
# SPDX-License-Identifier: MIT


####### Expanded from @PACKAGE_INIT@ by configure_package_config_file() #######
####### Any changes to this file will be overwritten by the next CMake run ####
####### The input file was c-ares-config.cmake.in                            ########

get_filename_component(PACKAGE_PREFIX_DIR "${CMAKE_CURRENT_LIST_DIR}/../../../" ABSOLUTE)

macro(set_and_check _var _file)
  set(${_var} "${_file}")
  if(NOT EXISTS "${_file}")
    message(FATAL_ERROR "File or directory ${_file} referenced by variable ${_var} does not exist !")
  endif()
endmacro()

####################################################################################

set_and_check(c-ares_INCLUDE_DIR "${PACKAGE_PREFIX_DIR}/include")

include("${CMAKE_CURRENT_LIST_DIR}/c-ares-config-version.cmake")
include("${CMAKE_CURRENT_LIST_DIR}/c-ares-targets.cmake")

set(c-ares_LIBRARY c-ares::cares)

if(ON)
	if(NOT TARGET c-ares::cares_shared)
		add_library(c-ares::cares_shared INTERFACE IMPORTED)
		set_target_properties(c-ares::cares_shared PROPERTIES INTERFACE_LINK_LIBRARIES "c-ares::cares")
	endif()
	set(c-ares_SHARED_LIBRARY c-ares::cares_shared)
endif()

if(ON)
	if(NOT TARGET c-ares::cares_static)
		add_library(c-ares::cares_static INTERFACE IMPORTED)
		set_target_properties(c-ares::cares_static PROPERTIES INTERFACE_LINK_LIBRARIES "c-ares::cares")
	endif()
	set(c-ares_STATIC_LIBRARY c-ares::cares_static)
endif()
