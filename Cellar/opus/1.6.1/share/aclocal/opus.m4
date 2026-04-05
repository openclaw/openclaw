# Configure paths for libopus
# Gregory Maxwell <greg@xiph.org> 08-30-2012
# Shamelessly stolen from Jack Moffitt (libogg) who
# Shamelessly stole from Owen Taylor and Manish Singh

dnl XIPH_PATH_OPUS([ACTION-IF-FOUND [, ACTION-IF-NOT-FOUND]])
dnl Test for libopus, and define OPUS_CFLAGS and OPUS_LIBS
dnl
AC_DEFUN([XIPH_PATH_OPUS],
[dnl
dnl Get the cflags and libraries
dnl
AC_ARG_WITH(opus,AC_HELP_STRING([--with-opus=PFX],[Prefix where opus is installed (optional)]), opus_prefix="$withval", opus_prefix="")
AC_ARG_WITH(opus-libraries,AC_HELP_STRING([--with-opus-libraries=DIR],[Directory where the opus library is installed (optional)]), opus_libraries="$withval", opus_libraries="")
AC_ARG_WITH(opus-includes,AC_HELP_STRING([--with-opus-includes=DIR],[Directory where the opus header files are installed (optional)]), opus_includes="$withval", opus_includes="")
AC_ARG_ENABLE(opustest,AC_HELP_STRING([--disable-opustest],[Do not try to compile and run a test opus program]),, enable_opustest=yes)

  if test "x$opus_libraries" != "x" ; then
    OPUS_LIBS="-L$opus_libraries"
  elif test "x$opus_prefix" = "xno" || test "x$opus_prefix" = "xyes" ; then
    OPUS_LIBS=""
  elif test "x$opus_prefix" != "x" ; then
    OPUS_LIBS="-L$opus_prefix/lib"
  elif test "x$prefix" != "xNONE" ; then
    OPUS_LIBS="-L$prefix/lib"
  fi

  if test "x$opus_prefix" != "xno" ; then
    OPUS_LIBS="$OPUS_LIBS -lopus"
  fi

  if test "x$opus_includes" != "x" ; then
    OPUS_CFLAGS="-I$opus_includes"
  elif test "x$opus_prefix" = "xno" || test "x$opus_prefix" = "xyes" ; then
    OPUS_CFLAGS=""
  elif test "x$opus_prefix" != "x" ; then
    OPUS_CFLAGS="-I$opus_prefix/include"
  elif test "x$prefix" != "xNONE"; then
    OPUS_CFLAGS="-I$prefix/include"
  fi

  AC_MSG_CHECKING(for Opus)
  if test "x$opus_prefix" = "xno" ; then
    no_opus="disabled"
    enable_opustest="no"
  else
    no_opus=""
  fi


  if test "x$enable_opustest" = "xyes" ; then
    ac_save_CFLAGS="$CFLAGS"
    ac_save_LIBS="$LIBS"
    CFLAGS="$CFLAGS $OPUS_CFLAGS"
    LIBS="$LIBS $OPUS_LIBS"
dnl
dnl Now check if the installed Opus is sufficiently new.
dnl
      rm -f conf.opustest
      AC_TRY_RUN([
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <opus.h>

int main (void)
{
  system("touch conf.opustest");
  return 0;
}

],, no_opus=yes,[echo $ac_n "cross compiling; assumed OK... $ac_c"])
       CFLAGS="$ac_save_CFLAGS"
       LIBS="$ac_save_LIBS"
  fi

  if test "x$no_opus" = "xdisabled" ; then
     AC_MSG_RESULT(no)
     ifelse([$2], , :, [$2])
  elif test "x$no_opus" = "x" ; then
     AC_MSG_RESULT(yes)
     ifelse([$1], , :, [$1])
  else
     AC_MSG_RESULT(no)
     if test -f conf.opustest ; then
       :
     else
       echo "*** Could not run Opus test program, checking why..."
       CFLAGS="$CFLAGS $OPUS_CFLAGS"
       LIBS="$LIBS $OPUS_LIBS"
       AC_TRY_LINK([
#include <stdio.h>
#include <opus.h>
],     [ return 0; ],
       [ echo "*** The test program compiled, but did not run. This usually means"
       echo "*** that the run-time linker is not finding Opus or finding the wrong"
       echo "*** version of Opus. If it is not finding Opus, you'll need to set your"
       echo "*** LD_LIBRARY_PATH environment variable, or edit /etc/ld.so.conf to point"
       echo "*** to the installed location  Also, make sure you have run ldconfig if that"
       echo "*** is required on your system"
       echo "***"
       echo "*** If you have an old version installed, it is best to remove it, although"
       echo "*** you may also be able to get things to work by modifying LD_LIBRARY_PATH"],
       [ echo "*** The test program failed to compile or link. See the file config.log for the"
       echo "*** exact error that occurred. This usually means Opus was incorrectly installed"
       echo "*** or that you have moved Opus since it was installed." ])
       CFLAGS="$ac_save_CFLAGS"
       LIBS="$ac_save_LIBS"
     fi
     OPUS_CFLAGS=""
     OPUS_LIBS=""
     ifelse([$2], , :, [$2])
  fi
  AC_SUBST(OPUS_CFLAGS)
  AC_SUBST(OPUS_LIBS)
  rm -f conf.opustest
])
