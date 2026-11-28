import Foundation

/// The recent photos marked in the "+" sheet. A tap on a photo's corner marks it and keeps the sheet open; a tap
/// anywhere else on a photo attaches the marked photos and that one, in the order they were marked.
struct ChatRecentPhotoSelection: Equatable {
    private(set) var marked: [String] = []

    mutating func toggle(_ id: String) {
        if let index = self.marked.firstIndex(of: id) {
            self.marked.remove(at: index)
        } else {
            self.marked.append(id)
        }
    }

    /// 1-based position in the marking order, shown on the photo's mark.
    func number(of id: String) -> Int? {
        self.marked.firstIndex(of: id).map { $0 + 1 }
    }

    /// What a tap on the body of the photo `id` attaches.
    func attaching(_ id: String) -> [String] {
        self.marked.contains(id) ? self.marked : self.marked + [id]
    }
}

extension OpenClawChatViewModel {
    /// The draft with `invocation` in front of it. A command already leading the draft is replaced, and the rest
    /// of the draft is kept as it is.
    nonisolated static func draft(_ draft: String, insertingCommand invocation: String) -> String {
        var rest = draft.drop(while: \.isWhitespace)
        if rest.hasPrefix("/"), !rest.hasPrefix("//") {
            rest = rest.drop(while: { !$0.isWhitespace }).drop(while: { $0 == " " || $0 == "\t" })
        }
        // The space after the command stays, so the caret lands ready for the request.
        return invocation + " " + rest
    }

    /// The command that runs `skill`: the catalog's own invocation when it lists the skill, otherwise its name
    /// in the catalog's spelling.
    func composerSkillInvocation(_ skill: OpenClawChatComposerSkill) -> String {
        let key = Self.commandSpelling(skill.key)
        let name = Self.commandSpelling(skill.name)
        let command = self.slashCommands.first { command in
            command.source == .skill && [key, name].contains(Self.commandSpelling(command.name))
        }
        return command?.displayInvocation ?? "/\(key)"
    }

    /// Turns an off skill on for this chat, then puts its command in front of the draft. When the change doesn't
    /// start or fails, it returns false and the draft stays as it was; the error shows where the sheet shows it.
    func turnOnComposerSkillAndInsert(_ skill: OpenClawChatComposerSkill) async -> Bool {
        if !self.composerSkillEnabled(skill) {
            let target = self.currentModelPatchTarget()
            self.toggleComposerSkill(skill)
            await self.waitForPendingSessionSettings(for: target)
        }
        guard self.composerSkillEnabled(skill) else { return false }
        self.insertComposerSkill(skill)
        return true
    }

    /// Puts the skill's command in front of the draft. Nothing runs until the draft is sent.
    func insertComposerSkill(_ skill: OpenClawChatComposerSkill) {
        self.input = Self.draft(self.input, insertingCommand: self.composerSkillInvocation(skill))
        self.errorText = nil
    }

    private nonisolated static func commandSpelling(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: " ", with: "_")
    }
}
