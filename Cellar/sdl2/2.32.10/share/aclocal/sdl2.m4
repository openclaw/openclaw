# Configure paths for SDL
# Sam Lantinga 9/21/99
# stolen from Manish Singh
# stolen back from Frank Belew
# stolen from Manish Singh
# Shamelessly stolen from Owen Taylor
#
# Changelog:
# * also look for SDL2.framework under Mac OS X
# * removed HP/UX 9 support.
# * updated for newer autoconf.
# * (v3) use $PKG_CONFIG for pkg-config cross-compiling support

# serial 3

dnl AM_PATH_SDL2([MINIMUM-VERSION, [ACTION-IF-FOUND [, ACTION-IF-NOT-FOUND]]])
dnl Test for SDL, and define SDL_CFLAGS and SDL_LIBS
dnl
AC_DEFUN([AM_PATH_SDL2],
[dnl
dnl Get the cflags and libraries from the sdl2-config script
dnl
AC_ARG_WITH(sdl-prefix,[  --with-sdl-prefix=PFX   Prefix where SDL is installed (optional)],
            sdl_prefix="$withval", sdl_prefix="")
AC_ARG_WITH(sdl-exec-prefix,[  --with-sdl-exec-prefix=PFX Exec prefix where SDL is installed (optional)],
            sdl_exec_prefix="$withval", sdl_exec_prefix="")
AC_ARG_ENABLE(sdltest, [  --disable-sdltest       Do not try to compile and run a test SDL program],
		    , enable_sdltest=yes)
AC_ARG_ENABLE(sdlframework, [  --disable-sdlframework Do not search for SDL2.framework],
        , search_sdl_framework=yes)

AC_ARG_VAR(SDL2_FRAMEWORK, [Path to SDL2.framework])

  min_sdl_version=ifelse([$1], ,2.0.0,$1)

  if test "x$sdl_prefix$sdl_exec_prefix" = x ; then
    PKG_CHECK_MODULES([SDL], [sdl2 >= $min_sdl_version],
           [sdl_pc=yes],
           [sdl_pc=no])
  else
    sdl_pc=no
    if test x$sdl_exec_prefix != x ; then
      sdl_config_args="$sdl_config_args --exec-prefix=$sdl_exec_prefix"
      if test x${SDL2_CONFIG+set} != xset ; then
        SDL2_CONFIG=$sdl_exec_prefix/bin/sdl2-config
      fi
    fi
    if test x$sdl_prefix != x ; then
      sdl_config_args="$sdl_config_args --prefix=$sdl_prefix"
      if test x${SDL2_CONFIG+set} != xset ; then
        SDL2_CONFIG=$sdl_prefix/bin/sdl2-config
      fi
    fi
  fi

  if test "x$sdl_pc" = xyes ; then
    no_sdl=""
    SDL2_CONFIG="$PKG_CONFIG sdl2"
  else
    as_save_PATH="$PATH"
    if test "x$prefix" != xNONE && test "$cross_compiling" != yes; then
      PATH="$prefix/bin:$prefix/usr/bin:$PATH"
    fi
    AC_PATH_PROG(SDL2_CONFIG, sdl2-config, no, [$PATH])
    PATH="$as_save_PATH"
    no_sdl=""

    if test "$SDL2_CONFIG" = "no" -a "x$search_sdl_framework" = "xyes"; then
      AC_MSG_CHECKING(for SDL2.framework)
      if test "x$SDL2_FRAMEWORK" != x; then
        sdl_framework=$SDL2_FRAMEWORK
      else
        for d in / ~/ /System/; do
          if test -d "${d}Library/Frameworks/SDL2.framework"; then
            sdl_framework="${d}Library/Frameworks/SDL2.framework"
          fi
        done
      fi

      if test x"$sdl_framework" != x && test -d "$sdl_framework"; then
        AC_MSG_RESULT($sdl_framework)
        sdl_framework_dir=`dirname $sdl_framework`
        SDL_CFLAGS="-F$sdl_framework_dir -Wl,-framework,SDL2 -I$sdl_framework/include"
        SDL_LIBS="-F$sdl_framework_dir -Wl,-framework,SDL2"
      else
        no_sdl=yes
      fi
    fi

    if test "$SDL2_CONFIG" != "no"; then
      if test "x$sdl_pc" = "xno"; then
        AC_MSG_CHECKING(for SDL - version >= $min_sdl_version)
        SDL_CFLAGS=`$SDL2_CONFIG $sdl_config_args --cflags`
        SDL_LIBS=`$SDL2_CONFIG $sdl_config_args --libs`
      fi

      sdl_major_version=`$SDL2_CONFIG $sdl_config_args --version | \
             sed 's/\([[0-9]]*\).\([[0-9]]*\).\([[0-9]]*\)/\1/'`
      sdl_minor_version=`$SDL2_CONFIG $sdl_config_args --version | \
             sed 's/\([[0-9]]*\).\([[0-9]]*\).\([[0-9]]*\)/\2/'`
      sdl_micro_version=`$SDL2_CONFIG $sdl_config_args --version | \
             sed 's/\([[0-9]]*\).\([[0-9]]*\).\([[0-9]]*\)/\3/'`
      if test "x$enable_sdltest" = "xyes" ; then
        ac_save_CFLAGS="$CFLAGS"
        ac_save_CXXFLAGS="$CXXFLAGS"
        ac_save_LIBS="$LIBS"
        CFLAGS="$CFLAGS $SDL_CFLAGS"
        CXXFLAGS="$CXXFLAGS $SDL_CFLAGS"
        LIBS="$LIBS $SDL_LIBS"
dnl
dnl Now check if the installed SDL is sufficiently new. (Also sanity
dnl checks the results of sdl2-config to some extent
dnl
      rm -f conf.sdltest
      AC_RUN_IFELSE([AC_LANG_SOURCE([[
#include <stdio.h>
#include <stdlib.h>
#include "SDL.h"

int main (int argc, char *argv[])
{
  int major, minor, micro;
  FILE *fp = fopen("conf.sdltest", "w");

  if (fp) fclose(fp);

  if (sscanf("$min_sdl_version", "%d.%d.%d", &major, &minor, &micro) != 3) {
     printf("%s, bad version string\n", "$min_sdl_version");
     exit(1);
   }

   if (($sdl_major_version > major) ||
      (($sdl_major_version == major) && ($sdl_minor_version > minor)) ||
      (($sdl_major_version == major) && ($sdl_minor_version == minor) && ($sdl_micro_version >= micro)))
    {
      return 0;
    }
  else
    {
      printf("\n*** 'sdl2-config --version' returned %d.%d.%d, but the minimum version\n", $sdl_major_version, $sdl_minor_version, $sdl_micro_version);
      printf("*** of SDL required is %d.%d.%d. If sdl2-config is correct, then it is\n", major, minor, micro);
      printf("*** best to upgrade to the required version.\n");
      printf("*** If sdl2-config was wrong, set the environment variable SDL2_CONFIG\n");
      printf("*** to point to the correct copy of sdl2-config, and remove the file\n");
      printf("*** config.cache before re-running configure\n");
      return 1;
    }
}

]])], [], [no_sdl=yes], [echo $ac_n "cross compiling; assumed OK... $ac_c"])
        CFLAGS="$ac_save_CFLAGS"
        CXXFLAGS="$ac_save_CXXFLAGS"
        LIBS="$ac_save_LIBS"

      fi
      if test "x$sdl_pc" = "xno"; then
        if test "x$no_sdl" = "xyes"; then
          AC_MSG_RESULT(no)
        else
          AC_MSG_RESULT(yes)
        fi
      fi
    fi
  fi
  if test "x$no_sdl" = x ; then
     ifelse([$2], , :, [$2])
  else
     if test "$SDL2_CONFIG" = "no" ; then
       echo "*** The sdl2-config script installed by SDL could not be found"
       echo "*** If SDL was installed in PREFIX, make sure PREFIX/bin is in"
       echo "*** your path, or set the SDL2_CONFIG environment variable to the"
       echo "*** full path to sdl2-config."
     else
       if test -f conf.sdltest ; then
        :
       else
          echo "*** Could not run SDL test program, checking why..."
          CFLAGS="$CFLAGS $SDL_CFLAGS"
          CXXFLAGS="$CXXFLAGS $SDL_CFLAGS"
          LIBS="$LIBS $SDL_LIBS"
          AC_LINK_IFELSE([AC_LANG_PROGRAM([[
#include <stdio.h>
#include "SDL.h"

int main(int argc, char *argv[])
{ return 0; }
#undef  main
#define main K_and_R_C_main
]], [[ return 0; ]])],
        [ echo "*** The test program compiled, but did not run. This usually means"
          echo "*** that the run-time linker is not finding SDL or finding the wrong"
          echo "*** version of SDL. If it is not finding SDL, you'll need to set your"
          echo "*** LD_LIBRARY_PATH environment variable, or edit /etc/ld.so.conf to point"
          echo "*** to the installed location  Also, make sure you have run ldconfig if that"
          echo "*** is required on your system"
	  echo "***"
          echo "*** If you have an old version installed, it is best to remove it, although"
          echo "*** you may also be able to get things to work by modifying LD_LIBRARY_PATH"],
        [ echo "*** The test program failed to compile or link. See the file config.log for the"
          echo "*** exact error that occurred. This usually means SDL was incorrectly installed"
          echo "*** or that you have moved SDL since it was installed. In the latter case, you"
          echo "*** may want to edit the sdl2-config script: $SDL2_CONFIG" ])
          CFLAGS="$ac_save_CFLAGS"
          CXXFLAGS="$ac_save_CXXFLAGS"
          LIBS="$ac_save_LIBS"
       fi
     fi
     SDL_CFLAGS=""
     SDL_LIBS=""
     ifelse([$3], , :, [$3])
  fi
  AC_SUBST(SDL_CFLAGS)
  AC_SUBST(SDL_LIBS)
  rm -f conf.sdltest
])
