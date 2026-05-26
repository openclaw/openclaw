import { Type } from "typebox";
export declare const WizardStartParamsSchema: Type.TObject<{
    mode: Type.TOptional<Type.TUnion<[Type.TLiteral<"local">, Type.TLiteral<"remote">]>>;
    workspace: Type.TOptional<Type.TString>;
}>;
export declare const WizardAnswerSchema: Type.TObject<{
    stepId: Type.TString;
    value: Type.TOptional<Type.TUnknown>;
}>;
export declare const WizardNextParamsSchema: Type.TObject<{
    sessionId: Type.TString;
    answer: Type.TOptional<Type.TObject<{
        stepId: Type.TString;
        value: Type.TOptional<Type.TUnknown>;
    }>>;
}>;
export declare const WizardCancelParamsSchema: Type.TObject<{
    sessionId: Type.TString;
}>;
export declare const WizardStatusParamsSchema: Type.TObject<{
    sessionId: Type.TString;
}>;
export declare const WizardStepOptionSchema: Type.TObject<{
    value: Type.TUnknown;
    label: Type.TString;
    hint: Type.TOptional<Type.TString>;
}>;
export declare const WizardStepSchema: Type.TObject<{
    id: Type.TString;
    type: Type.TUnion<[Type.TLiteral<"note">, Type.TLiteral<"select">, Type.TLiteral<"text">, Type.TLiteral<"confirm">, Type.TLiteral<"multiselect">, Type.TLiteral<"progress">, Type.TLiteral<"action">]>;
    title: Type.TOptional<Type.TString>;
    message: Type.TOptional<Type.TString>;
    format: Type.TOptional<Type.TUnion<[Type.TLiteral<"plain">]>>;
    options: Type.TOptional<Type.TArray<Type.TObject<{
        value: Type.TUnknown;
        label: Type.TString;
        hint: Type.TOptional<Type.TString>;
    }>>>;
    initialValue: Type.TOptional<Type.TUnknown>;
    placeholder: Type.TOptional<Type.TString>;
    sensitive: Type.TOptional<Type.TBoolean>;
    executor: Type.TOptional<Type.TUnion<[Type.TLiteral<"gateway">, Type.TLiteral<"client">]>>;
}>;
export declare const WizardNextResultSchema: Type.TObject<{
    done: Type.TBoolean;
    step: Type.TOptional<Type.TObject<{
        id: Type.TString;
        type: Type.TUnion<[Type.TLiteral<"note">, Type.TLiteral<"select">, Type.TLiteral<"text">, Type.TLiteral<"confirm">, Type.TLiteral<"multiselect">, Type.TLiteral<"progress">, Type.TLiteral<"action">]>;
        title: Type.TOptional<Type.TString>;
        message: Type.TOptional<Type.TString>;
        format: Type.TOptional<Type.TUnion<[Type.TLiteral<"plain">]>>;
        options: Type.TOptional<Type.TArray<Type.TObject<{
            value: Type.TUnknown;
            label: Type.TString;
            hint: Type.TOptional<Type.TString>;
        }>>>;
        initialValue: Type.TOptional<Type.TUnknown>;
        placeholder: Type.TOptional<Type.TString>;
        sensitive: Type.TOptional<Type.TBoolean>;
        executor: Type.TOptional<Type.TUnion<[Type.TLiteral<"gateway">, Type.TLiteral<"client">]>>;
    }>>;
    status: Type.TOptional<Type.TUnion<[Type.TLiteral<"running">, Type.TLiteral<"done">, Type.TLiteral<"cancelled">, Type.TLiteral<"error">]>>;
    error: Type.TOptional<Type.TString>;
}>;
export declare const WizardStartResultSchema: Type.TObject<{
    done: Type.TBoolean;
    step: Type.TOptional<Type.TObject<{
        id: Type.TString;
        type: Type.TUnion<[Type.TLiteral<"note">, Type.TLiteral<"select">, Type.TLiteral<"text">, Type.TLiteral<"confirm">, Type.TLiteral<"multiselect">, Type.TLiteral<"progress">, Type.TLiteral<"action">]>;
        title: Type.TOptional<Type.TString>;
        message: Type.TOptional<Type.TString>;
        format: Type.TOptional<Type.TUnion<[Type.TLiteral<"plain">]>>;
        options: Type.TOptional<Type.TArray<Type.TObject<{
            value: Type.TUnknown;
            label: Type.TString;
            hint: Type.TOptional<Type.TString>;
        }>>>;
        initialValue: Type.TOptional<Type.TUnknown>;
        placeholder: Type.TOptional<Type.TString>;
        sensitive: Type.TOptional<Type.TBoolean>;
        executor: Type.TOptional<Type.TUnion<[Type.TLiteral<"gateway">, Type.TLiteral<"client">]>>;
    }>>;
    status: Type.TOptional<Type.TUnion<[Type.TLiteral<"running">, Type.TLiteral<"done">, Type.TLiteral<"cancelled">, Type.TLiteral<"error">]>>;
    error: Type.TOptional<Type.TString>;
    sessionId: Type.TString;
}>;
export declare const WizardStatusResultSchema: Type.TObject<{
    status: Type.TUnion<[Type.TLiteral<"running">, Type.TLiteral<"done">, Type.TLiteral<"cancelled">, Type.TLiteral<"error">]>;
    error: Type.TOptional<Type.TString>;
}>;
