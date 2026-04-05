// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 2001-2014 International Business Machines
*   Corporation and others.  All Rights Reserved.
**********************************************************************
*  FILE NAME : ustream.h
*
*   Modification History:
*
*   Date        Name        Description
*   06/25/2001  grhoten     Move iostream from unistr.h
******************************************************************************
*/

#ifndef USTREAM_H
#define USTREAM_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/unistr.h"

#if !UCONFIG_NO_CONVERSION  // not available without conversion

/**
 * \file
 * \brief C++ API: Unicode iostream like API
 *
 * At this time, this API is very limited. It contains
 * operator<< and operator>> for UnicodeString manipulation with the
 * C++ I/O stream API.
 */

#if defined(__GLIBCXX__)
namespace std { class type_info; } // WORKAROUND: http://llvm.org/bugs/show_bug.cgi?id=13364
#endif

#include <iostream>

U_NAMESPACE_BEGIN

/**
 * Write the contents of a UnicodeString to a C++ ostream. This functions writes
 * the characters in a UnicodeString to an ostream. The UChars in the
 * UnicodeString are converted to the char based ostream with the default
 * converter.
 * @stable 3.0
 */
U_IO_API std::ostream & U_EXPORT2 operator<<(std::ostream& stream, const UnicodeString& s);

/**
 * Write the contents from a C++ istream to a UnicodeString. The UChars in the
 * UnicodeString are converted from the char based istream with the default
 * converter.
 * @stable 3.0
 */
U_IO_API std::istream & U_EXPORT2 operator>>(std::istream& stream, UnicodeString& s);
U_NAMESPACE_END

#endif

/* No operator for UChar because it can conflict with wchar_t  */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
