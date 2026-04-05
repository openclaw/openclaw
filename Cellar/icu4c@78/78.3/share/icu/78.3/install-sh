#!/bin/sh
#
# install - install a program, script, or datafile
# This comes from X11R5 (mit/util/scripts/install.sh).
#
# Copyright 1991 by the Massachusetts Institute of Technology
#
# Permission to use, copy, modify, distribute, and sell this software and its
# documentation for any purpose is hereby granted without fee, provided that
# the above copyright notice appear in all copies and that both that
# copyright notice and this permission notice appear in supporting
# documentation, and that the name of M.I.T. not be used in advertising or
# publicity pertaining to distribution of the software without specific,
# written prior permission.  M.I.T. makes no representations about the
# suitability of this software for any purpose.  It is provided "as is"
# without express or implied warranty.
#
# Calling this script install-sh is preferred over install.sh, to prevent
# `make' implicit rules from creating a file called install from it
# when there is no Makefile.
#
# This script is compatible with the BSD install script, but was written
# from scratch.  It can only install one file at a time, a restriction
# shared with many OS's install programs.


# set DOITPROG to echo to test this script

# Don't use :- since 4.3BSD and earlier shells don't like it.
doit="${DOITPROG-}"


# put in absolute paths if you don't have them in your path; or use env. vars.

mvprog="${MVPROG-mv}"
cpprog="${CPPROG-cp}"
chmodprog="${CHMODPROG-chmod}"
chownprog="${CHOWNPROG-chown}"
chgrpprog="${CHGRPPROG-chgrp}"
stripprog="${STRIPPROG-strip}"
rmprog="${RMPROG-rm}"
mkdirprog="${MKDIRPROG-mkdir}"

transformbasename=""
transform_arg=""
instcmd="$mvprog"
chmodcmd="$chmodprog 0755"
chowncmd=""
chgrpcmd=""
stripcmd=""
rmcmd="$rmprog -f"
mvcmd="$mvprog"
src=""
dst=""
dir_arg=""

while [ x"$1" != x ]; do
    case $1 in
	-c) instcmd="$cpprog"
	    shift
	    continue;;

	-d) dir_arg=true
	    shift
	    continue;;

	-m) chmodcmd="$chmodprog $2"
	    shift
	    shift
	    continue;;

	-o) chowncmd="$chownprog $2"
	    shift
	    shift
	    continue;;

	-g) chgrpcmd="$chgrpprog $2"
	    shift
	    shift
	    continue;;

	-s) stripcmd="$stripprog"
	    shift
	    continue;;

	-t=*) transformarg=`echo $1 | sed 's/-t=//'`
	    shift
	    continue;;

	-b=*) transformbasename=`echo $1 | sed 's/-b=//'`
	    shift
	    continue;;

	*)  if [ x"$src" = x ]
	    then
		src=$1
	    else
		# this colon is to work around a 386BSD /bin/sh bug
		:
		dst=$1
	    fi
	    shift
	    continue;;
    esac
done

if [ x"$src" = x ]
then
	echo "install:	no input file specified"
	exit 1
else
	true
fi

if [ x"$dir_arg" != x ]; then
	dst=$src
	src=""
	
	if [ -d $dst ]; then
		instcmd=:
		chmodcmd=""
	else
		instcmd=mkdir
	fi
else

# Waiting for this to be detected by the "$instcmd $src $dsttmp" command
# might cause directories to be created, which would be especially bad 
# if $src (and thus $dsttmp) contains '*'.

	if [ -f $src -o -d $src ]
	then
		true
	else
		echo "install:  $src does not exist"
		exit 1
	fi
	
	if [ x"$dst" = x ]
	then
		echo "install:	no destination specified"
		exit 1
	else
		true
	fi

# If destination is a directory, append the input filename; if your system
# does not like double slashes in filenames, you may need to add some logic

	if [ -d $dst ]
	then
		dst="$dst"/`basename $src`
	else
		true
	fi
fi

## this sed command emulates the dirname command
dstdir=`echo $dst | sed -e 's,[^/]*$,,;s,/$,,;s,^$,.,'`

# Make sure that the destination directory exists.
#  this part is taken from Noah Friedman's mkinstalldirs script

# Skip lots of stat calls in the usual case.
if [ ! -d "$dstdir" ]; then
defaultIFS='	
'
IFS="${IFS-${defaultIFS}}"

oIFS="${IFS}"
# Some sh's can't handle IFS=/ for some reason.
IFS='%'
set - `echo ${dstdir} | sed -e 's@/@%@g' -e 's@^%@/@'`
IFS="${oIFS}"

pathcomp=''

while [ $# -ne 0 ] ; do
	pathcomp="${pathcomp}${1}"
	shift

	if [ ! -d "${pathcomp}" ] ;
        then
		$mkdirprog "${pathcomp}"
	else
		true
	fi

	pathcomp="${pathcomp}/"
done
fi

if [ x"$dir_arg" != x ]
then
	$doit $instcmd $dst &&

	if [ x"$chowncmd" != x ]; then $doit $chowncmd $dst; else true ; fi &&
	if [ x"$chgrpcmd" != x ]; then $doit $chgrpcmd $dst; else true ; fi &&
	if [ x"$stripcmd" != x ]; then $doit $stripcmd $dst; else true ; fi &&
	if [ x"$chmodcmd" != x ]; then $doit $chmodcmd $dst; else true ; fi
else

# If we're going to rename the final executable, determine the name now.

	if [ x"$transformarg" = x ] 
	then
		dstfile=`basename $dst`
	else
		dstfile=`basename $dst $transformbasename | 
			sed $transformarg`$transformbasename
	fi

# don't allow the sed command to completely eliminate the filename

	if [ x"$dstfile" = x ] 
	then
		dstfile=`basename $dst`
	else
		true
	fi

# Make a temp file name in the proper directory.

	dsttmp=$dstdir/#inst.$$#

# Move or copy the file name to the temp name

	$doit $instcmd $src $dsttmp &&

	trap "rm -f ${dsttmp}" 0 &&

# and set any options; do chmod last to preserve setuid bits

# If any of these fail, we abort the whole thing.  If we want to
# ignore errors from any of these, just make sure not to ignore
# errors from the above "$doit $instcmd $src $dsttmp" command.

	if [ x"$chowncmd" != x ]; then $doit $chowncmd $dsttmp; else true;fi &&
	if [ x"$chgrpcmd" != x ]; then $doit $chgrpcmd $dsttmp; else true;fi &&
	if [ x"$stripcmd" != x ]; then $doit $stripcmd $dsttmp; else true;fi &&
	if [ x"$chmodcmd" != x ]; then $doit $chmodcmd $dsttmp; else true;fi &&

# Now rename the file to the real destination.

	$doit $rmcmd -f $dstdir/$dstfile &&
	$doit $mvcmd $dsttmp $dstdir/$dstfile 

fi &&


exit 0
