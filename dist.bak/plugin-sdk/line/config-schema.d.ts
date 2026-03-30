import { z } from "zod";
export declare const LineConfigSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    channelAccessToken: z.ZodOptional<z.ZodString>;
    channelSecret: z.ZodOptional<z.ZodString>;
    tokenFile: z.ZodOptional<z.ZodString>;
    secretFile: z.ZodOptional<z.ZodString>;
    name: z.ZodOptional<z.ZodString>;
    allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
    dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        allowlist: "allowlist";
        open: "open";
        disabled: "disabled";
        pairing: "pairing";
    }>>>;
    groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        allowlist: "allowlist";
        open: "open";
        disabled: "disabled";
    }>>>;
    responsePrefix: z.ZodOptional<z.ZodString>;
    mediaMaxMb: z.ZodOptional<z.ZodNumber>;
    webhookPath: z.ZodOptional<z.ZodString>;
    accounts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        channelAccessToken: z.ZodOptional<z.ZodString>;
        channelSecret: z.ZodOptional<z.ZodString>;
        tokenFile: z.ZodOptional<z.ZodString>;
        secretFile: z.ZodOptional<z.ZodString>;
        name: z.ZodOptional<z.ZodString>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        groupAllowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        dmPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            allowlist: "allowlist";
            open: "open";
            disabled: "disabled";
            pairing: "pairing";
        }>>>;
        groupPolicy: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
            allowlist: "allowlist";
            open: "open";
            disabled: "disabled";
        }>>>;
        responsePrefix: z.ZodOptional<z.ZodString>;
        mediaMaxMb: z.ZodOptional<z.ZodNumber>;
        webhookPath: z.ZodOptional<z.ZodString>;
        groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
            requireMention: z.ZodOptional<z.ZodBoolean>;
            systemPrompt: z.ZodOptional<z.ZodString>;
            skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
        }, z.core.$strict>>>>;
    }, z.core.$strict>>>>;
    groups: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        allowFrom: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>>;
        requireMention: z.ZodOptional<z.ZodBoolean>;
        systemPrompt: z.ZodOptional<z.ZodString>;
        skills: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>>>;
}, z.core.$strict>;
export type LineConfigSchemaType = z.infer<typeof LineConfigSchema>;
