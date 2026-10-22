/// Ordinary operation capabilities, not provider enrollment or persisted scope grants.
public enum GatewayOperatorScopeAccess {
    public static func allowsWrite(_ scopes: some Collection<String>) -> Bool {
        scopes.contains("operator.admin") || scopes.contains("operator.write") ||
            scopes.contains("operator.write.no-credential-enrollment")
    }

    public static func allowsRead(_ scopes: some Collection<String>) -> Bool {
        scopes.contains("operator.read") || scopes.contains("operator.read.no-credential-enrollment") ||
            self.allowsWrite(scopes)
    }
}
