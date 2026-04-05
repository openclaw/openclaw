// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
*
*   Copyright (C) 2009-2014, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
*******************************************************************************
*   file name:  std_string.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2009feb19
*   created by: Markus W. Scherer
*/

#ifndef __STD_STRING_H__
#define __STD_STRING_H__

/**
 * \file
 * \brief C++ API: Central ICU header for including the C++ standard &lt;string&gt;
 *                 header and for related definitions.
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

// Workaround for a libstdc++ bug before libstdc++4.6 (2011).
// https://bugs.llvm.org/show_bug.cgi?id=13364
#if defined(__GLIBCXX__)
namespace std { class type_info; }
#endif
#include <string>

#endif /* U_SHOW_CPLUSPLUS_API */

#endif  // __STD_STRING_H__
