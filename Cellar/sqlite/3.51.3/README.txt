This package contains:

 * the SQLite library amalgamation source code file: sqlite3.c
 * the sqlite3.h and sqlite3ext.h header files that define the C-language
   interface to the sqlite3.c library file
 * the shell.c file used to build the sqlite3 command-line shell program
 * autoconf-like installation infrastucture for building on POSIX
   compliant systems
 * a Makefile.msc, sqlite3.rc, and Replace.cs for building with Microsoft
   Visual C++ on Windows

WHY USE THIS PACKAGE?
=====================

The canonical make system for SQLite requires TCL as part of the build
process.  Various TCL scripts are used to generate parts of the code and
TCL is used to run tests.  But some people would prefer to build SQLite
using only generic tools and without having to install TCL.  The purpose
of this package is to provide that capability.

This package contains a pre-build SQLite amalgamation file "sqlite3.c"
(and its associated header file "sqlite3.h").  Because the
amalgamation has been pre-built, no TCL is required for the code
generate (the configure script itself is written in TCL but it can use
the embedded copy of JimTCL).

REASONS TO USE THE CANONICAL BUILD SYSTEM RATHER THAN THIS PACKAGE
==================================================================

 * the canonical build system allows you to run tests to verify that
   the build worked
 * the canonical build system supports more compile-time options
 * the canonical build system works for any arbitrary check-in to
   the SQLite source tree

Step-by-step instructions on how to build using the canonical make
system for SQLite can be found at:

  https://sqlite.org/src/doc/trunk/doc/compile-for-unix.md
  https://sqlite.org/src/doc/trunk/doc/compile-for-windows.md


SUMMARY OF HOW TO BUILD USING THIS PACKAGE
==========================================

  Unix:      ./configure; make
  Windows:   nmake /f Makefile.msc

BUILDING ON POSIX
=================

The configure script follows common conventions, making it easy
to use for anyone who has configured a software tree before.
It supports a number of build-time flags, the full list of which
can be seen by running:

  ./configure --help

The default value for the CFLAGS variable (options passed to the C
compiler) includes debugging symbols in the build, resulting in larger
binaries than are necessary. Override it on the configure command
line like this:

  $ CFLAGS="-Os" ./configure

to produce a smaller installation footprint.

Many SQLite compilation parameters can be defined by passing flags
to the configure script. Others may be passed on in the CFLAGS. For
example:

  $ CFLAGS="-Os -DSQLITE_OMIT_DEPRECATED" ./configure


BUILDING WITH MICROSOFT VISUAL C++
==================================

To compile for Windows using Microsoft Visual C++:

  $ nmake /f Makefile.msc

Using Microsoft Visual C++ 2005 (or later) is recommended.  Several Windows
platform variants may be built by adding additional macros to the NMAKE
command line.


Other preprocessor defines
--------------------------

Additionally, preprocessor defines may be specified by using the OPTS macro
on the NMAKE command line.  However, not all possible preprocessor defines
may be specified in this manner as some require the amalgamation to be built
with them enabled (see http://sqlite.org/compile.html). For example, the
following will work:

  "OPTS=-DSQLITE_ENABLE_STAT4=1 -DSQLITE_OMIT_JSON=1"

However, the following will not compile unless the amalgamation was built
with it enabled:

  "OPTS=-DSQLITE_ENABLE_UPDATE_DELETE_LIMIT=1"
