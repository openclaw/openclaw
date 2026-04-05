# Copyright (C) 2016 and later: Unicode, Inc. and others.
# License & terms of use: http://www.unicode.org/copyright.html
## -*-makefile-*-
#******************************************************************************
#   Copyright (C) 1999-2014, International Business Machines
#   Corporation and others.  All Rights Reserved.
#******************************************************************************
# This Makefile.inc is designed to be included into projects which make use
# of the ICU.

# CONTENTS OF THIS FILE
# 1). Base configuration information and linkage
# 2). Variables giving access to ICU tools
# 3). Host information
# 4). Compiler flags and settings 
# 5). Data Packaging directives
# 6). Include of platform make fragment (mh-* file)

##################################################################
##################################################################
#
#       *1*  base configuration information and linkage
#
##################################################################
# The PREFIX is the base of where ICU is installed.
# Inside this directory you should find  bin, lib, include/unicode, 
# etc.  If ICU is not installed in this directory, you must change the
# following line.  There should exist $(prefix)/include/unicode/utypes.h
# for example.
prefix = /opt/homebrew/Cellar/icu4c@78/78.3
exec_prefix = ${prefix}
libdir = /opt/homebrew/Cellar/icu4c@78/78.3/lib
libexecdir = ${exec_prefix}/libexec
bindir = ${exec_prefix}/bin
datarootdir = ${prefix}/share
datadir = ${datarootdir}
sbindir = ${exec_prefix}/sbin

# about the ICU version
VERSION = 78.3
UNICODE_VERSION = 17.0

# The prefix for ICU libraries, normally 'icu'
ICUPREFIX = icu
PACKAGE = icu
LIBICU = lib$(ICUPREFIX)

# Static library prefix and file extension
STATIC_PREFIX = s
LIBSICU = lib$(STATIC_PREFIX)$(ICUPREFIX)
A = a

# Suffix at the end of libraries. Usually empty.
ICULIBSUFFIX = 
# ICULIBSUFFIX_VERSION  is non-empty if it is to contain a library
# version. For example, if it is 21, it means libraries are named
# libicuuc21.so for example.

# rpath links a library search path right into the binaries.
## mh-files MUST NOT override RPATHLDFLAGS unless they provide
## equivalent '#SH#' lines for icu-config fixup
ENABLE_RPATH = NO
ifeq ($(ENABLE_RPATH),YES)
RPATHLDFLAGS = $(LD_RPATH)$(LD_RPATH_PRE)$(libdir)
endif

#SH## icu-config version of above 'if':
#SH#case "x$ENABLE_RPATH" in 
#SH#     x[yY]*)
#SH# 	ENABLE_RPATH=YES
#SH# 	RPATHLDFLAGS="${LD_RPATH}${LD_RPATH_PRE}${libdir}"
#SH# 	;;
#SH#
#SH#     x[nN]*)
#SH# 	ENABLE_RPATH=NO
#SH# 	RPATHLDFLAGS=""
#SH# 	;;
#SH#
#SH#     x)
#SH# 	ENABLE_RPATH=NO
#SH# 	RPATHLDFLAGS=""
#SH# 	;;
#SH#
#SH#     *)
#SH# 	echo $0: Unknown --enable-rpath value ${ENABLE_RPATH} 1>&2
#SH# 	exit 3
#SH# 	;;
#SH#esac

# Name flexibility for the library naming scheme.  Any modifications should
# be made in the mh- file for the specific platform.
DATA_STUBNAME = data
COMMON_STUBNAME = uc
I18N_STUBNAME = i18n
LAYOUTEX_STUBNAME = lx
IO_STUBNAME = io
TOOLUTIL_STUBNAME = tu
CTESTFW_STUBNAME = test
 


### To link your application with ICU:
# 1. use LDFLAGS, CFLAGS, etc from above
# 2. link with $(ICULIBS)
# 3. optionally, add one or more of:
#    - $(ICULIBS_I18N)    - i18n library, formatting, etc.
#    - $(ICULIBS_ICUIO)   - ICU stdio equivalent library

ICULIBS_COMMON = -l$(ICUPREFIX)uc$(ICULIBSUFFIX)$(ICULIBSUFFIX_VERSION)
ICULIBS_DATA   = -l$(ICUPREFIX)$(DATA_STUBNAME)$(ICULIBSUFFIX)$(ICULIBSUFFIX_VERSION)
ICULIBS_I18N   = -l$(ICUPREFIX)$(I18N_STUBNAME)$(ICULIBSUFFIX)$(ICULIBSUFFIX_VERSION)
ICULIBS_TOOLUTIL = -l$(ICUPREFIX)tu$(ICULIBSUFFIX)$(ICULIBSUFFIX_VERSION)
ICULIBS_CTESTFW = -l$(ICUPREFIX)ctestfw$(ICULIBSUFFIX)$(ICULIBSUFFIX_VERSION)
ICULIBS_ICUIO = -l$(ICUPREFIX)io$(ICULIBSUFFIX)$(ICULIBSUFFIX_VERSION)
ICULIBS_OBSOLETE = -l$(ICUPREFIX)obsolete$(ICULIBSUFFIX)$(ICULIBSUFFIX_VERSION)
ICULIBS_LAYOUTEX = -l$(ICUPREFIX)lx$(ICULIBSUFFIX)$(ICULIBSUFFIX_VERSION)
ICULIBS_BASE = -L$(libdir)

# for icu-config to test with
ICULIBS_COMMON_LIB_NAME = ${LIBICU}${COMMON_STUBNAME}${ICULIBSUFFIX}${ICULIBSUFFIX_VERSION}.${SO}
ICULIBS_COMMON_LIB_NAME_A = ${LIBICU}${COMMON_STUBNAME}${ICULIBSUFFIX}.${A}

# ICULIBS is the set of libraries your application should link
# with usually. Many applications will want to add $(ICULIBS_I18N) as well. 
ICULIBS = $(ICULIBS_BASE) $(ICULIBS_I18N) $(ICULIBS_COMMON) $(ICULIBS_DATA) 

# Proper echo newline handling is needed in icu-config
ECHO_N=
ECHO_C=\c
# Not currently being used but good to have for proper tab handling
ECHO_T=

##################################################################
##################################################################
#
#       *2*  access to ICU tools
#
##################################################################
# Environment variable to set a runtime search path
#   (Overridden when necessary in -mh files)
LDLIBRARYPATH_ENVVAR = LD_LIBRARY_PATH

# Versioned target for a shared library
FINAL_SO_TARGET = $(SO_TARGET).$(SO_TARGET_VERSION)
MIDDLE_SO_TARGET = $(SO_TARGET).$(SO_TARGET_VERSION_MAJOR)

# Access to important ICU tools.
# Use as follows:  $(INVOKE) $(GENRB) arguments .. 
INVOKE = $(LDLIBRARYPATH_ENVVAR)=$(libdir):$$$(LDLIBRARYPATH_ENVVAR) $(LEAK_CHECKER)
GENCCODE = $(sbindir)/genccode
ICUPKG   = $(sbindir)/icupkg
GENCMN   = $(sbindir)/gencmn
GENRB    = $(bindir)/genrb
PKGDATA  = $(bindir)/pkgdata

# moved here because of dependencies
pkgdatadir = $(datadir)/$(PACKAGE)$(ICULIBSUFFIX)/$(VERSION)
pkglibdir = $(libdir)/$(PACKAGE)$(ICULIBSUFFIX)/$(VERSION)

##################################################################
##################################################################
#
#       *3*  Information about the host
#
##################################################################

# Information about the host that 'configure' was run on.
host = aarch64-apple-darwin25.3.0
host_alias = 
host_cpu = aarch64
host_vendor = apple
host_os = darwin25.3.0
# Our platform canonical name (as determined by configure)
# this is a #define value (i.e. U_XXXX or XXXX)
platform = U_DARWIN

##################################################################
##################################################################
#
#       *4*  compiler flags and misc. options
#
##################################################################
AR = ar
# initial tab keeps it out of the shell version.
	ARFLAGS :=  $(ARFLAGS)
#SH#ARFLAGS=" ${ARFLAGS}"
CC = clang
CPP = clang -E
CFLAGS =  -std=c11 
CPPFLAGS =  -I$(prefix)/include
CXXFLAGS =  -std=c++17
CXX = clang++
DEFAULT_MODE = dll
DEFS = -DPACKAGE_NAME=\"ICU\" -DPACKAGE_TARNAME=\"icu4c\" -DPACKAGE_VERSION=\"78.3\" -DPACKAGE_STRING=\"ICU\ 78.3\" -DPACKAGE_BUGREPORT=\"https://icu.unicode.org/bugs\" -DPACKAGE_URL=\"https://icu.unicode.org/\" -DHAVE_STDIO_H=1 -DHAVE_STDLIB_H=1 -DHAVE_STRING_H=1 -DHAVE_INTTYPES_H=1 -DHAVE_STDINT_H=1 -DHAVE_STRINGS_H=1 -DHAVE_SYS_STAT_H=1 -DHAVE_SYS_TYPES_H=1 -DHAVE_UNISTD_H=1 -DSTDC_HEADERS=1 -DSIZEOF_VOID_P=8 -DHAVE_LIBM=1 -DHAVE_DLFCN_H=1 -DHAVE_DLOPEN=1 -DHAVE_GETTIMEOFDAY=1 -DHAVE_LIBPTHREAD=1 -DHAVE_DIRENT_H=1 -DHAVE_WCHAR_H=1 -DSIZEOF_WCHAR_T=4 
# use a consistent INSTALL 
INSTALL  =  $(SHELL) $(pkgdatadir)/install-sh -c
INSTALL_DATA  =  ${INSTALL} -m 644
INSTALL_DATA = ${INSTALL} -m 644
INSTALL_PROGRAM  =  ${INSTALL}
INSTALL_PROGRAM = ${INSTALL}
INSTALL_SCRIPT = ${INSTALL}
LDFLAGS = $(RPATHLDFLAGS)
LIBS = -lpthread -lm  
LIB_M = 
LIB_VERSION = 78.3
LIB_VERSION_MAJOR = 78
MKINSTALLDIRS = $(SHELL) $(pkgdatadir)/mkinstalldirs
RANLIB = ranlib
RMV = rm -rf
SHELL = /bin/sh
SHLIB.c=      $(CC) $(DEFS) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -shared
SHLIB.cc=     $(CXX) $(DEFS) $(CPPFLAGS) $(CXXFLAGS) $(LDFLAGS) -shared
U_IS_BIG_ENDIAN = 0
includedir = ${prefix}/include
infodir = ${datarootdir}/info
localstatedir = ${prefix}/var
mandir = ${datarootdir}/man
oldincludedir = /usr/include
program_transform_name = s,x,x,
sharedstatedir = ${prefix}/com
sysconfdir = ${prefix}/etc
INSTALL-L = ${INSTALL_DATA}

# for derivative builds - don't bother with VERBOSE/NONVERBOSE SILENT_COMPILE
SILENT_COMPILE=$(1)  #M#
ICU_MSG=@echo "   $(1)	"  #M#

##################################################################
##################################################################
#
#       *5* packaging options and directories
#
##################################################################


# The basename of the ICU data file (i.e. icudt21b )
ICUDATA_CHAR = l
ICUDATA_NAME = icudt78l

# Defaults for pkgdata's mode and directories
# The default data dir changes depending on what packaging mode 
# is being used
ifeq ($(strip $(PKGDATA_MODE)),)
#SH# if [ "x$PKGDATA_MODE" = "x" ];
#SH# then
PKGDATA_MODE=dll
#SH# fi
endif

#SH# case "$PKGDATA_MODE" in
ifeq ($(PKGDATA_MODE),common)
#SH# common)
ICUDATA_DIR = $(pkgdatadir)
ICUPKGDATA_DIR = $(ICUDATA_DIR)
#SH# ;;
else
ifeq ($(PKGDATA_MODE),dll)
#SH# dll)
ICUDATA_DIR = $(pkgdatadir)
ICUPKGDATA_DIR = $(libdir)
#SH# ;;
else
#SH# *)
ICUDATA_DIR = $(pkgdatadir)
ICUPKGDATA_DIR = $(ICUDATA_DIR)
#SH# ;;
endif
endif

#SH# esac

GENCCODE_ASSEMBLY = 

##################################################################
##################################################################
#
#       *6* Inclusion of platform make fragment (mh-* file)
#
##################################################################
# The mh- file ("make fragment") for the platform is included here. 
# It may override the above settings.
# It is put last so that the mh-file can override anything.
# The selfcheck is just a sanity check that this makefile is
# parseable. The mh fragment is only included if this does not occur.

ifeq (selfcheck,$(MAKECMDGOALS)) #M#
selfcheck: #M#
	@echo passed #M#
else #M#
include $(pkgdatadir)/config/mh-darwin
endif #M#

