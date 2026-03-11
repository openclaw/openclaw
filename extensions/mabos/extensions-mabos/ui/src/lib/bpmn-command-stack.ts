/**
 * Command pattern for undo/redo in the BPMN editor.
 * Each mutation creates a reversible command.
 */

export interface BpmnCommand {
  type: string;
  execute: () => void;
  undo: () => void;
}

export class BpmnCommandStack {
  private undoStack: BpmnCommand[] = [];
  private redoStack: BpmnCommand[] = [];
  private maxHistory = 50;

  execute(command: BpmnCommand) {
    command.execute();
    this.undoStack.push(command);
    this.redoStack = []; // clear redo on new action
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
  }

  undo(): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;
    command.undo();
    this.redoStack.push(command);
    return true;
  }

  redo(): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;
    command.execute();
    this.undoStack.push(command);
    return true;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
}
