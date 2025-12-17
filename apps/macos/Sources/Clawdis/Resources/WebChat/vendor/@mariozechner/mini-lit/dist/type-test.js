const testDef = {
    myString: {
        type: "value",
        default: "", // This becomes literal ""
        description: "test",
    },
    myBoolean: {
        type: "value",
        default: false, // This becomes literal false
        description: "test",
    },
};
export {};
// The issue: we're using "as const" which makes everything literal types!
// The default: "" becomes type "" not string
// The default: false becomes type false not boolean
//# sourceMappingURL=type-test.js.map