//go:build windows

package main

import "os/exec"

func configureCodexPromptCommand(command *exec.Cmd) {
	command.WaitDelay = docsI18nCommandWaitDelay()
}
