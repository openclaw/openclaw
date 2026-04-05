// © 2024 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#include "unicode/utypes.h"

#ifndef MESSAGEFORMAT2_ARGUMENTS_H
#define MESSAGEFORMAT2_ARGUMENTS_H

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_NORMALIZATION

#if !UCONFIG_NO_FORMATTING

#if !UCONFIG_NO_MF2

/**
 * \file
 * \brief C++ API: Formats messages using the draft MessageFormat 2.0.
 */

#include "unicode/messageformat2_data_model_names.h"
#include "unicode/messageformat2_formattable.h"
#include "unicode/unistr.h"

#ifndef U_HIDE_DEPRECATED_API

#include <map>

U_NAMESPACE_BEGIN

namespace message2 {

    class MessageFormatter;

    // Arguments
    // ----------

    /**
     *
     * The `MessageArguments` class represents the named arguments to a message.
     * It is immutable and movable. It is not copyable.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API_CLASS MessageArguments : public UObject {
    public:
        /**
         * Message arguments constructor, which takes a map and returns a container
         * of arguments that can be passed to a `MessageFormatter`.
         *
         * @param args A reference to a map from strings (argument names) to `message2::Formattable`
         *        objects (argument values). The keys and values of the map are copied into the result.
         * @param status Input/output error code.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API MessageArguments(const std::map<UnicodeString, Formattable>& args, UErrorCode& status) {
            if (U_FAILURE(status)) {
                return;
            }
            argumentNames = LocalArray<UnicodeString>(new UnicodeString[argsLen = static_cast<int32_t>(args.size())]);
            arguments = LocalArray<Formattable>(new Formattable[argsLen]);
            if (!argumentNames.isValid() || !arguments.isValid()) {
                status = U_MEMORY_ALLOCATION_ERROR;
                return;
            }
            int32_t i = 0;
            for (auto iter = args.begin(); iter != args.end(); ++iter) {
                argumentNames[i] = iter->first;
                arguments[i] = iter->second;
                i++;
            }
        }
        /**
         * Move operator:
         * The source MessageArguments will be left in a valid but undefined state.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API MessageArguments& operator=(MessageArguments&&) noexcept;
        /**
         * Default constructor.
         * Returns an empty arguments mapping.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API MessageArguments() = default;
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API virtual ~MessageArguments();
    private:
        friend class MessageContext;

        const Formattable* getArgument(const data_model::VariableName&,
                                       UErrorCode&) const;

        // Avoids using Hashtable so that code constructing a Hashtable
        // doesn't have to appear in this header file
        LocalArray<UnicodeString> argumentNames;
        LocalArray<Formattable> arguments;
        int32_t argsLen = 0;
    }; // class MessageArguments

} // namespace message2

U_NAMESPACE_END

#endif // U_HIDE_DEPRECATED_API

#endif /* #if !UCONFIG_NO_MF2 */

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* #if !UCONFIG_NO_NORMALIZATION */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // MESSAGEFORMAT2_ARGUMENTS_H

// eof
