# sdl2 cmake project-config input for ./configure script

include(FeatureSummary)
set_package_properties(SDL2 PROPERTIES
    URL "https://www.libsdl.org/"
    DESCRIPTION "low level access to audio, keyboard, mouse, joystick, and graphics hardware"
)

# Copied from `configure_package_config_file`
macro(set_and_check _var _file)
    set(${_var} "${_file}")
    if(NOT EXISTS "${_file}")
        message(FATAL_ERROR "File or directory ${_file} referenced by variable ${_var} does not exist !")
    endif()
endmacro()

get_filename_component(CMAKE_CURRENT_LIST_DIR ${CMAKE_CURRENT_LIST_DIR} REALPATH)
get_filename_component(prefix "${CMAKE_CURRENT_LIST_DIR}/../../.." ABSOLUTE)

set(exec_prefix "${prefix}")
set(bindir "${exec_prefix}/bin")
set(libdir "${exec_prefix}/lib")
set(includedir "${prefix}/include")

set_and_check(SDL2_PREFIX         "${prefix}")
set_and_check(SDL2_EXEC_PREFIX    "${exec_prefix}")
set_and_check(SDL2_BINDIR         "${bindir}")
set_and_check(SDL2_INCLUDE_DIR    "${includedir}/SDL2")
set_and_check(SDL2_LIBDIR         "${libdir}")
set(SDL2_INCLUDE_DIRS             "${includedir};${SDL2_INCLUDE_DIR}")

set(SDL2_LIBRARIES SDL2::SDL2)
set(SDL2_STATIC_LIBRARIES SDL2::SDL2-static)
set(SDL2MAIN_LIBRARY)
set(SDL2TEST_LIBRARY SDL2::SDL2test)

unset(prefix)
unset(exec_prefix)
unset(bindir)
unset(libdir)
unset(includedir)

set(_sdl2_libraries_in "-lSDL2")
set(_sdl2_static_private_libs_in " -lm  -Wl,-framework,CoreAudio -Wl,-framework,AudioToolbox -Wl,-weak_framework,CoreHaptics -Wl,-weak_framework,GameController -Wl,-framework,ForceFeedback -lobjc -Wl,-framework,CoreVideo -Wl,-framework,Cocoa -Wl,-framework,Carbon -Wl,-framework,IOKit -Wl,-weak_framework,QuartzCore -Wl,-weak_framework,Metal")

# Convert _sdl2_libraries to list and keep only libraries + library directories
string(REGEX MATCHALL "-[lm]([-a-zA-Z0-9._]+)" _sdl2_libraries "${_sdl2_libraries_in}")
string(REGEX REPLACE "^-l" "" _sdl2_libraries "${_sdl2_libraries}")
string(REGEX REPLACE ";-l" ";" _sdl2_libraries "${_sdl2_libraries}")
string(REGEX MATCHALL "-L([-a-zA-Z0-9._/]+)" _sdl2_libdirs "${_sdl2_libraries_in}")
string(REGEX REPLACE "^-L" "" _sdl2_libdirs "${_sdl2_libdirs}")
string(REGEX REPLACE ";-L" ";" _sdl2_libdirs "${_sdl2_libdirs}")
list(APPEND _sdl2_libdirs "${SDL2_LIBDIR}")

# Convert _sdl2_static_private_libs to list and keep only libraries + library directories
string(REGEX MATCHALL "(-[lm]([-a-zA-Z0-9._]+))|(-Wl,[^ ]*framework[^ ]*)|(-pthread)" _sdl2_static_private_libs "${_sdl2_static_private_libs_in}")
string(REGEX REPLACE "^-l" "" _sdl2_static_private_libs "${_sdl2_static_private_libs}")
string(REGEX REPLACE ";-l" ";" _sdl2_static_private_libs "${_sdl2_static_private_libs}")
string(REGEX REPLACE "-Wl,-framework,([a-zA-Z0-9_]+)" "$<LINK_LIBRARY:FRAMEWORK,\\1>" _sdl2_static_private_libs "${_sdl2_static_private_libs}")
string(REGEX REPLACE "-Wl,-weak_framework,([a-zA-Z0-9_]+)" "$<LINK_LIBRARY:WEAK_FRAMEWORK,\\1>" _sdl2_static_private_libs "${_sdl2_static_private_libs}")

string(REGEX MATCHALL "-L([-a-zA-Z0-9._/]+)" _sdl2_static_private_libdirs "${_sdl2_static_private_libs_in}")
string(REGEX REPLACE "^-L" "" _sdl2_static_private_libdirs "${_sdl2_static_private_libdirs}")
string(REGEX REPLACE ";-L" ";" _sdl2_static_private_libdirs "${_sdl2_static_private_libdirs}")

# Set SDL2_NO_MWINDOWS to a true-ish value to not add the -mwindows link option
if(SDL2_NO_MWINDOWS)
  list(REMOVE_ITEM _sdl2_libraries "-mwindows")
endif()

if(_sdl2_libraries MATCHES ".*SDL2main.*")
  list(INSERT SDL2_LIBRARIES 0 SDL2::SDL2main)
  list(INSERT SDL2_STATIC_LIBRARIES 0 SDL2::SDL2main)
endif()

set(_sdl2main_library ${SDL2_LIBDIR}/libSDL2main.a)
if(EXISTS "${_sdl2main_library}")
  set(SDL2MAIN_LIBRARY SDL2::SDL2main)
  if(NOT TARGET SDL2::SDL2main)
    add_library(SDL2::SDL2main STATIC IMPORTED)
    set_target_properties(SDL2::SDL2main
      PROPERTIES
        IMPORTED_LOCATION "${_sdl2main_library}"
        COMPATIBLE_INTERFACE_STRING "SDL_VERSION"
        INTERFACE_SDL_VERSION "SDL2"
    )
    if(WIN32)
      # INTERFACE_LINK_OPTIONS needs CMake 3.13
      cmake_minimum_required(VERSION 3.13)
      # Mark WinMain/WinMain@16 as undefined, such that it will be withheld by the linker.
      if(CMAKE_SIZEOF_VOID_P EQUAL 4)
        set_target_properties(SDL2::SDL2main
          PROPERTIES
            INTERFACE_LINK_OPTIONS "$<$<STREQUAL:$<TARGET_PROPERTY:TYPE>,EXECUTABLE>:-Wl,--undefined=_WinMain@16>"
        )
      else()
        set_target_properties(SDL2::SDL2main
          PROPERTIES
            INTERFACE_LINK_OPTIONS "$<$<STREQUAL:$<TARGET_PROPERTY:TYPE>,EXECUTABLE>:-Wl,--undefined=WinMain>"
        )
      endif()
    endif()
  endif()
  set(SDL2_SDL2main_FOUND TRUE)
else()
  set(SDL2_SDL2main_FOUND FALSE)
endif()
unset(_sdl2main_library)

# Remove SDL2 since this is the "central" library
# Remove SDL2main since this will be provided by SDL2::SDL2main (if available)
# Remove mingw32 and cygwin since these are not needed when using `-Wl,--undefined,WinMain`
set(_sdl2_link_libraries ${_sdl2_libraries})
list(REMOVE_ITEM _sdl2_link_libraries SDL2 SDL2main mingw32 cygwin)

if(WIN32)
  set(_sdl2_implib "${SDL2_LIBDIR}/libSDL2.dll.a")
  set(_sdl2_dll "${SDL2_BINDIR}/SDL2.dll")
  if(EXISTS "${_sdl2_implib}" AND EXISTS "${_sdl2_dll}")
    if(NOT TARGET SDL2::SDL2)
      add_library(SDL2::SDL2 SHARED IMPORTED)
      set_target_properties(SDL2::SDL2 PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${SDL2_INCLUDE_DIR}"
        INTERFACE_LINK_LIBRARIES "${_sdl2_link_libraries}"
        INTERFACE_LINK_DIRECTORIES "${_sdl2_libdirs}"
        IMPORTED_LINK_INTERFACE_LANGUAGES "C"
        IMPORTED_IMPLIB "${_sdl2_implib}"
        IMPORTED_LOCATION "${_sdl2_dll}"
        COMPATIBLE_INTERFACE_STRING "SDL_VERSION"
        INTERFACE_SDL_VERSION "SDL2"
      )
    endif()
    set(SDL2_SDL2_FOUND TRUE)
  else()
    set(SDL2_SDL2_FOUND FALSE)
  endif()
  unset(_sdl2_implib)
  unset(_sdl2_dll)
else()
  set(_sdl2_shared "${SDL2_LIBDIR}/libSDL2${CMAKE_SHARED_LIBRARY_SUFFIX}")
  if(EXISTS "${_sdl2_shared}")
    if(NOT TARGET SDL2::SDL2)
      add_library(SDL2::SDL2 SHARED IMPORTED)
      set_target_properties(SDL2::SDL2 PROPERTIES
        INTERFACE_INCLUDE_DIRECTORIES "${SDL2_INCLUDE_DIR}"
        INTERFACE_LINK_LIBRARIES "${_sdl2_link_libraries}"
        INTERFACE_LINK_DIRECTORIES "${_sdl2_libdirs}"
        IMPORTED_LINK_INTERFACE_LANGUAGES "C"
        IMPORTED_LOCATION "${_sdl2_shared}"
        COMPATIBLE_INTERFACE_STRING "SDL_VERSION"
        INTERFACE_SDL_VERSION "SDL2"
      )
    endif()
    set(SDL2_SDL2_FOUND TRUE)
  else()
    set(SDL2_SDL2_FOUND FALSE)
  endif()
  unset(_sdl2_shared)
endif()

set(_sdl2_static "${SDL2_LIBDIR}/libSDL2.a")
if(EXISTS "${_sdl2_static}")
  if(NOT TARGET SDL2::SDL2-static)
    add_library(SDL2::SDL2-static STATIC IMPORTED)
    set_target_properties(SDL2::SDL2-static
      PROPERTIES
        IMPORTED_LOCATION "${_sdl2_static}"
        INTERFACE_INCLUDE_DIRECTORIES "${SDL2_INCLUDE_DIR}"
        INTERFACE_LINK_LIBRARIES "${_sdl2_link_libraries};${_sdl2_static_private_libs}"
        INTERFACE_LINK_DIRECTORIES "${_sdl2_libdirs};${_sdl2_static_private_libdirs}"
        IMPORTED_LINK_INTERFACE_LANGUAGES "C"
        COMPATIBLE_INTERFACE_STRING "SDL_VERSION"
        INTERFACE_SDL_VERSION "SDL2"
    )
  endif()
  set(SDL2_SDL2-static_FOUND TRUE)
else()
  set(SDL2_SDL2-static_FOUND FALSE)
endif()
unset(_sdl2_static)

unset(_sdl2_link_libraries)

set(_sdl2test_library "${SDL2_LIBDIR}/libSDL2_test.a")
if(EXISTS "${_sdl2test_library}")
  if(NOT TARGET SDL2::SDL2test)
    add_library(SDL2::SDL2test STATIC IMPORTED)
    set_target_properties(SDL2::SDL2test
      PROPERTIES
        IMPORTED_LOCATION "${_sdl2test_library}"
        INTERFACE_INCLUDE_DIRECTORIES "${SDL2_INCLUDE_DIR}"
        IMPORTED_LINK_INTERFACE_LANGUAGES "C"
        COMPATIBLE_INTERFACE_STRING "SDL_VERSION"
        INTERFACE_SDL_VERSION "SDL2"
    )
  endif()
  set(SDL2_SDL2test_FOUND TRUE)
else()
  set(SDL2_SDL2test_FOUND FALSE)
endif()
unset(_sdl2test_library)

# Copied from `configure_package_config_file`
macro(check_required_components _NAME)
  foreach(comp ${${_NAME}_FIND_COMPONENTS})
    if(NOT ${_NAME}_${comp}_FOUND)
      if(${_NAME}_FIND_REQUIRED_${comp})
        set(${_NAME}_FOUND FALSE)
      endif()
    endif()
  endforeach()
endmacro()

check_required_components(SDL2)

# Create SDL2::SDL2 alias for static-only builds
if(TARGET SDL2::SDL2-static AND NOT TARGET SDL2::SDL2)
  if(CMAKE_VERSION VERSION_LESS "3.18")
    # FIXME: Aliasing local targets is not supported on CMake < 3.18, so make it global.
    add_library(SDL2::SDL2 INTERFACE IMPORTED)
    set_target_properties(SDL2::SDL2 PROPERTIES INTERFACE_LINK_LIBRARIES "SDL2::SDL2-static")
  else()
    add_library(SDL2::SDL2 ALIAS SDL2::SDL2-static)
  endif()
endif()
