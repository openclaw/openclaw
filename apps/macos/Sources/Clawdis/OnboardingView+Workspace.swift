import Foundation

extension OnboardingView {
    func loadWorkspaceDefaults() async {
        guard self.workspacePath.isEmpty else { return }
        let configured = await self.loadAgentWorkspace()
        let url = AgentWorkspace.resolveWorkspaceURL(from: configured)
        self.workspacePath = AgentWorkspace.displayPath(for: url)
        self.refreshBootstrapStatus()
    }

    func ensureDefaultWorkspace() async {
        guard self.state.connectionMode == .local else { return }
        let configured = await self.loadAgentWorkspace()
        let url = AgentWorkspace.resolveWorkspaceURL(from: configured)
        switch AgentWorkspace.bootstrapSafety(for: url) {
        case .safe:
            do {
                _ = try AgentWorkspace.bootstrap(workspaceURL: url)
                if (configured ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    await self.saveAgentWorkspace(AgentWorkspace.displayPath(for: url))
                }
            } catch {
                self.workspaceStatus = "Failed to create workspace: \(error.localizedDescription)"
            }
        case let .unsafe(reason):
            self.workspaceStatus = "Workspace not touched: \(reason)"
        }
        self.refreshBootstrapStatus()
    }

    func refreshBootstrapStatus() {
        let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
        self.needsBootstrap = AgentWorkspace.needsBootstrap(workspaceURL: url)
        if self.needsBootstrap {
            self.didAutoKickoff = false
        }
    }

    var workspaceBootstrapCommand: String {
        let template = AgentWorkspace.defaultTemplate().trimmingCharacters(in: .whitespacesAndNewlines)
        return """
        mkdir -p ~/.clawdis/workspace
        cat > ~/.clawdis/workspace/AGENTS.md <<'EOF'
        \(template)
        EOF
        """
    }

    func applyWorkspace() async {
        guard !self.workspaceApplying else { return }
        self.workspaceApplying = true
        defer { self.workspaceApplying = false }

        do {
            let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
            if case let .unsafe(reason) = AgentWorkspace.bootstrapSafety(for: url) {
                self.workspaceStatus = "Workspace not created: \(reason)"
                return
            }
            _ = try AgentWorkspace.bootstrap(workspaceURL: url)
            self.workspacePath = AgentWorkspace.displayPath(for: url)
            self.workspaceStatus = "Workspace ready at \(self.workspacePath)"
            self.refreshBootstrapStatus()
        } catch {
            self.workspaceStatus = "Failed to create workspace: \(error.localizedDescription)"
        }
    }

    private func loadAgentWorkspace() async -> String? {
        let root = await ConfigStore.load()
        let agent = root["agent"] as? [String: Any]
        return agent?["workspace"] as? String
    }

    @discardableResult
    func saveAgentWorkspace(_ workspace: String?) async -> Bool {
        let (success, errorMessage) = await OnboardingView.buildAndSaveWorkspace(workspace)

        if let errorMessage {
            self.workspaceStatus = errorMessage
        }
        return success
    }

    private nonisolated static func buildAndSaveWorkspace(_ workspace: String?) async -> (Bool, String?) {
        var root = await ConfigStore.load()
        var agent = root["agent"] as? [String: Any] ?? [:]
        let trimmed = workspace?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            agent.removeValue(forKey: "workspace")
        } else {
            agent["workspace"] = trimmed
        }
        if agent.isEmpty {
            root.removeValue(forKey: "agent")
        } else {
            root["agent"] = agent
        }
        do {
            try await ConfigStore.save(root)
            return (true, nil)
        } catch let error {
            let errorMessage = "Failed to save config: \(error.localizedDescription)"
            return (false, errorMessage)
        }
    }
}
