// © 2024 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#include "unicode/utypes.h"

#ifndef MESSAGEFORMAT_DATA_MODEL_NAMES_H
#define MESSAGEFORMAT_DATA_MODEL_NAMES_H

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#if !UCONFIG_NO_MF2

#include "unicode/unistr.h"

#ifndef U_HIDE_DEPRECATED_API

U_NAMESPACE_BEGIN

namespace message2 {

    namespace data_model {
        typedef UnicodeString VariableName;
        typedef UnicodeString FunctionName;
    } // namespace data_model
} // namespace message2

U_NAMESPACE_END

#endif // U_HIDE_DEPRECATED_API

#endif /* #if !UCONFIG_NO_MF2 */

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // MESSAGEFORMAT_DATA_MODEL_NAMES_H

// eof

