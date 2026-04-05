// © 2024 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#include "unicode/utypes.h"

#ifndef MESSAGEFORMAT2_H
#define MESSAGEFORMAT2_H

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_NORMALIZATION

#if !UCONFIG_NO_FORMATTING

#if !UCONFIG_NO_MF2

/**
 * \file
 * \brief C++ API: Formats messages using the draft MessageFormat 2.0.
 */

#include "unicode/messageformat2_arguments.h"
#include "unicode/messageformat2_data_model.h"
#include "unicode/messageformat2_function_registry.h"
#include "unicode/normalizer2.h"
#include "unicode/unistr.h"

#ifndef U_HIDE_DEPRECATED_API

U_NAMESPACE_BEGIN

namespace message2 {

    class Environment;
    class MessageContext;
    class StaticErrors;
    class InternalValue;

    /**
     * <p>MessageFormatter is a Technical Preview API implementing MessageFormat 2.0.
     *
     * <p>See <a target="github" href="https://github.com/unicode-org/message-format-wg/blob/main/spec/syntax.md">the
     * description of the syntax with examples and use cases</a> and the corresponding
     * <a target="github" href="https://github.com/unicode-org/message-format-wg/blob/main/spec/message.abnf">ABNF</a> grammar.</p>
     *
     * The MessageFormatter class is mutable and movable. It is not copyable.
     * (It is mutable because if it has a custom function registry, the registry may include
     * `FormatterFactory` objects implementing custom formatters, which are allowed to contain
     * mutable state.)
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API_CLASS MessageFormatter : public UObject {
        // Note: This class does not currently inherit from the existing
        // `Format` class.
    public:
        /**
         * Move assignment operator:
         * The source MessageFormatter will be left in a valid but undefined state.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API MessageFormatter& operator=(MessageFormatter&&) noexcept;
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API virtual ~MessageFormatter();

        /**
         * Formats the message to a string, using the data model that was previously set or parsed,
         * and the given `arguments` object.
         *
         * @param arguments Reference to message arguments
         * @param status    Input/output error code used to indicate syntax errors, data model
         *                  errors, resolution errors, formatting errors, selection errors, as well
         *                  as other errors (such as memory allocation failures). Partial output
         *                  is still provided in the presence of most error types.
         * @return          The string result of formatting the message with the given arguments.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API UnicodeString formatToString(const MessageArguments& arguments, UErrorCode& status);

        /**
         * Not yet implemented; formats the message to a `FormattedMessage` object,
         * using the data model that was previously set or parsed,
         * and the given `arguments` object.
         *
         * @param arguments Reference to message arguments
         * @param status    Input/output error code used to indicate syntax errors, data model
         *                  errors, resolution errors, formatting errors, selection errors, as well
         *                  as other errors (such as memory allocation failures). Partial output
         *                  is still provided in the presence of most error types.
         * @return          The `FormattedMessage` representing the formatted message.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API FormattedMessage format(const MessageArguments& arguments, UErrorCode& status) const {
            (void) arguments;
            if (U_SUCCESS(status)) {
                status = U_UNSUPPORTED_ERROR;
            }
            return FormattedMessage(status);
        }

        /**
         * Accesses the locale that this `MessageFormatter` object was created with.
         *
         * @return A reference to the locale.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const Locale& getLocale() const { return locale; }

        /**
         * Serializes the data model as a string in MessageFormat 2.0 syntax.
         *
         * @return result    A string representation of the data model.
         *                   The string is a valid MessageFormat 2.0 message.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API UnicodeString getPattern() const;

        /**
         * Accesses the data model referred to by this
         * `MessageFormatter` object.
         *
         * @return A reference to the data model.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const MFDataModel& getDataModel() const;

        /**
         * Used in conjunction with the
         * MessageFormatter::Builder::setErrorHandlingBehavior() method.
         *
         * @internal ICU 76 technology preview
         * @deprecated This API is for technology preview only.
         */
        typedef enum UMFErrorHandlingBehavior {
            /**
             * Suppress errors and return best-effort output.
             *
             * @internal ICU 76 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_MF_BEST_EFFORT = 0,
            /**
             * Signal all MessageFormat errors using the UErrorCode
             * argument.
             *
             * @internal ICU 76 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_MF_STRICT
        } UMFErrorHandlingBehavior;

        /**
         * The mutable Builder class allows each part of the MessageFormatter to be initialized
         * separately; calling its `build()` method yields an immutable MessageFormatter.
         *
         * Not copyable or movable.
         */
        class U_I18N_API_CLASS Builder : public UObject {
        private:
            friend class MessageFormatter;

            // The pattern to be parsed to generate the formatted message
            UnicodeString pattern;
            bool hasPattern = false;
            bool hasDataModel = false;
            // The data model to be used to generate the formatted message
            // Initialized either by `setDataModel()`, or by the parser
            // through a call to `setPattern()`
            MFDataModel dataModel;
            // Normalized representation of the pattern;
            // ignored if `setPattern()` wasn't called
            UnicodeString normalizedInput;
            // Errors (internal representation of parse errors)
            // Ignored if `setPattern()` wasn't called
            StaticErrors* errors;
            Locale locale;
            // Not owned
            const MFFunctionRegistry* customMFFunctionRegistry;
            // Error behavior; see comment in `MessageFormatter` class
            bool signalErrors = false;

            void clearState();
        public:
            /**
             * Sets the locale to use for formatting.
             *
             * @param locale The desired locale.
             * @return       A reference to the builder.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Builder& setLocale(const Locale& locale);
            /**
             * Sets the pattern (contents of the message) and parses it
             * into a data model. If a data model was
             * previously set, it is removed.
             *
             * @param pattern A string in MessageFormat 2.0 syntax.
             * @param parseError Struct to receive information on the position
             *                   of an error within the pattern.
             * @param status    Input/output error code. If the
             *                  pattern cannot be parsed, set to failure code.
             * @return       A reference to the builder.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Builder& setPattern(const UnicodeString& pattern,
                                           UParseError& parseError,
                                           UErrorCode& status);
            /**
             * Sets a custom function registry.
             *
             * @param functionRegistry Reference to the function registry to use.
             *        `functionRegistry` is not copied,
             *        and the caller must ensure its lifetime contains
             *        the lifetime of the `MessageFormatter` object built by this
             *        builder.
             * @return       A reference to the builder.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Builder& setFunctionRegistry(const MFFunctionRegistry& functionRegistry);
            /**
             * Sets a data model. If a pattern was previously set, it is removed.
             *
             * @param dataModel Data model to format. Passed by move.
             * @return       A reference to the builder.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Builder& setDataModel(MFDataModel&& dataModel);
            /**
             * Set the error handling behavior for this formatter.
             *
             * "Strict" error behavior means that that formatting methods
             * will set their UErrorCode arguments to signal MessageFormat
             * data model, resolution, and runtime errors. Syntax errors are
             * always signaled.
             *
             * "Best effort" error behavior means that MessageFormat errors are
             * suppressed:  formatting methods will _not_ set their
             * UErrorCode arguments to signal MessageFormat data model,
             * resolution, or runtime errors. Best-effort output
             * will be returned. Syntax errors are always signaled.
             * This is the default behavior.
             *
             * @param type An enum with type UMFErrorHandlingBehavior;
             *             if type == `U_MF_STRICT`, then
             *             errors are handled strictly.
             *             If type == `U_MF_BEST_EFFORT`, then
             *             best-effort output is returned.
             *
             * The default is to suppress all MessageFormat errors
             * and return best-effort output.
             *
             * @return       A reference to the builder.
             *
             * @internal ICU 76 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Builder& setErrorHandlingBehavior(UMFErrorHandlingBehavior type);
            /**
             * Constructs a new immutable MessageFormatter using the pattern or data model
             * that was previously set, and the locale (if it was previously set)
             * or default locale (otherwise).
             *
             * The builder object (`this`) can still be used after calling `build()`.
             *
             * @param status    Input/output error code.  If neither the pattern
             *                  nor the data model is set, set to failure code.
             * @return          The new MessageFormatter object
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API MessageFormatter build(UErrorCode& status) const;
            /**
             * Default constructor.
             * Returns a Builder with the default locale and with no
             * data model or pattern set. Either `setPattern()`
             * or `setDataModel()` has to be called before calling `build()`.
             *
             * @param status    Input/output error code.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Builder(UErrorCode& status);
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API virtual ~Builder();
        }; // class MessageFormatter::Builder

        // TODO: Shouldn't be public; only used for testing
        /**
         * Returns a string consisting of the input with optional spaces removed.
         *
         * @return        A normalized string representation of the input
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const UnicodeString& getNormalizedPattern() const { return normalizedInput; }

    private:
        friend class Builder;
        friend class Checker;
        friend class MessageArguments;
        friend class MessageContext;

        MessageFormatter(const MessageFormatter::Builder& builder, UErrorCode &status);

        MessageFormatter() = delete; // default constructor not implemented

        // Do not define default assignment operator
        const MessageFormatter &operator=(const MessageFormatter &) = delete;

        // Selection methods

        // Takes a vector of FormattedPlaceholders
        void resolveSelectors(MessageContext&, const Environment& env, UErrorCode&, UVector&) const;
        // Takes a vector of vectors of strings (input) and a vector of PrioritizedVariants (output)
        void filterVariants(const UVector&, UVector&, UErrorCode&) const;
        // Takes a vector of vectors of strings (input) and a vector of PrioritizedVariants (input/output)
        void sortVariants(const UVector&, UVector&, UErrorCode&) const;
        // Takes a vector of strings (input) and a vector of strings (output)
        void matchSelectorKeys(const UVector&, MessageContext&, InternalValue* rv, UVector&, UErrorCode&) const;
        // Takes a vector of FormattedPlaceholders (input),
        // and a vector of vectors of strings (output)
        void resolvePreferences(MessageContext&, UVector&, UVector&, UErrorCode&) const;

        // Formatting methods

        [[nodiscard]] FormattedPlaceholder formatLiteral(const UnicodeString&, const data_model::Literal&) const;
        void formatPattern(MessageContext&, const Environment&, const data_model::Pattern&, UErrorCode&, UnicodeString&) const;
        // Evaluates a function call
        // Dispatches on argument type
        [[nodiscard]] InternalValue* evalFunctionCall(FormattedPlaceholder&& argument,
                                                     MessageContext& context,
                                                     UErrorCode& status) const;
        // Dispatches on function name
        [[nodiscard]] InternalValue* evalFunctionCall(const FunctionName& functionName,
                                                     InternalValue* argument,
                                                     FunctionOptions&& options,
                                                     MessageContext& context,
                                                     UErrorCode& status) const;
        // Formats an expression that appears in a pattern or as the definition of a local variable
        [[nodiscard]] InternalValue* formatExpression(const UnicodeString&,
                                                      const Environment&,
                                                      const data_model::Expression&,
                                                      MessageContext&,
                                                      UErrorCode&) const;
        [[nodiscard]] FunctionOptions resolveOptions(const Environment& env, const OptionMap&, MessageContext&, UErrorCode&) const;
        [[nodiscard]] InternalValue* formatOperand(const UnicodeString&,
                                                   const Environment&,
                                                   const data_model::Operand&,
                                                   MessageContext&,
                                                   UErrorCode&) const;
        [[nodiscard]] FormattedPlaceholder evalArgument(const UnicodeString&,
                                                        const data_model::VariableName&,
                                                        MessageContext&,
                                                        UErrorCode&) const;
        void formatSelectors(MessageContext& context, const Environment& env, UErrorCode &status, UnicodeString& result) const;

        // Function registry methods
        bool hasCustomMFFunctionRegistry() const {
            return (customMFFunctionRegistry != nullptr);
        }

        // Precondition: custom function registry exists
        // Note: this is non-const because the values in the MFFunctionRegistry are mutable
        // (a FormatterFactory can have mutable state)
        const MFFunctionRegistry& getCustomMFFunctionRegistry() const;

        bool isCustomFormatter(const FunctionName&) const;
        FormatterFactory* lookupFormatterFactory(const FunctionName&, UErrorCode& status) const;
        bool isBuiltInSelector(const FunctionName&) const;
        bool isBuiltInFormatter(const FunctionName&) const;
        bool isCustomSelector(const FunctionName&) const;
        const SelectorFactory* lookupSelectorFactory(MessageContext&, const FunctionName&, UErrorCode&) const;
        bool isSelector(const FunctionName& fn) const { return isBuiltInSelector(fn) || isCustomSelector(fn); }
        bool isFormatter(const FunctionName& fn) const { return isBuiltInFormatter(fn) || isCustomFormatter(fn); }
        const Formatter* lookupFormatter(const FunctionName&, UErrorCode&) const;

        Selector* getSelector(MessageContext&, const FunctionName&, UErrorCode&) const;
        Formatter* getFormatter(const FunctionName&, UErrorCode&) const;
        bool getDefaultFormatterNameByType(const UnicodeString&, FunctionName&) const;

        // Checking for resolution errors
        void checkDeclarations(MessageContext&, Environment*&, UErrorCode&) const;
        void check(MessageContext&, const Environment&, const data_model::Expression&, UErrorCode&) const;
        void check(MessageContext&, const Environment&, const data_model::Operand&, UErrorCode&) const;
        void check(MessageContext&, const Environment&, const OptionMap&, UErrorCode&) const;

        void initErrors(UErrorCode&);
        void clearErrors() const;
        void cleanup() noexcept;

        // The locale this MessageFormatter was created with
        /* const */ Locale locale;

        // Registry for built-in functions
        MFFunctionRegistry standardMFFunctionRegistry;
        // Registry for custom functions; may be null if no custom registry supplied
        // Note: this is *not* owned by the MessageFormatter object
        // The reason for this choice is to have a non-destructive MessageFormatter::Builder,
        // while also not requiring the function registry to be deeply-copyable. Making the
        // function registry copyable would impose a requirement on any implementations
        // of the FormatterFactory and SelectorFactory interfaces to implement a custom
        // clone() method, which is necessary to avoid sharing between copies of the
        // function registry (and thus double-frees)
        // Not deeply immutable (the values in the function registry are mutable,
        // as a FormatterFactory can have mutable state
        const MFFunctionRegistry* customMFFunctionRegistry;

        // Data model, representing the parsed message
        MFDataModel dataModel;

        // Normalized version of the input string (optional whitespace removed)
        UnicodeString normalizedInput;

        // Errors -- only used while parsing and checking for data model errors; then
        // the MessageContext keeps track of errors
        // Must be a raw pointer to avoid including the internal header file
        // defining StaticErrors
        // Owned by `this`
        StaticErrors* errors = nullptr;

        // Error handling behavior.
        // If true, then formatting methods set their UErrorCode arguments
        // to signal MessageFormat errors, and no useful output is returned.
        // If false, then MessageFormat errors are not signaled and the
        // formatting methods return best-effort output.
        // The default is false.
        bool signalErrors = false;

    }; // class MessageFormatter

} // namespace message2

U_NAMESPACE_END

#endif // U_HIDE_DEPRECATED_API

#endif /* #if !UCONFIG_NO_MF2 */

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* #if !UCONFIG_NO_NORMALIZATION */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // MESSAGEFORMAT2_H

// eof
