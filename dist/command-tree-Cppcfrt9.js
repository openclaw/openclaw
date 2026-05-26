//#region src/cli/program/command-tree.ts
function removeCommand(program, command) {
	const commands = program.commands;
	const index = commands.indexOf(command);
	if (index < 0) return false;
	commands.splice(index, 1);
	return true;
}
function removeCommandByName(program, name) {
	const existing = program.commands.find((command) => command.name() === name || command.aliases().includes(name));
	if (!existing) return false;
	return removeCommand(program, existing);
}
//#endregion
export { removeCommandByName as t };
