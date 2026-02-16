/**
 * Create a contract from a classified + dispatched message.
 */

import type { Db, Contract } from "./db.js";
import type { DispatchResult } from "./dispatcher.js";

export type ContractInput = {
  dispatch: DispatchResult;
  message_id: string;
  message_platform: string;
  message_account?: string;
  sender_email: string;
  sender_name?: string;
  attachment_ids?: string[];
};

export async function createContract(
  db: Db,
  input: ContractInput,
): Promise<Contract> {
  const { dispatch } = input;
  const project = dispatch.project;

  return db.createContract({
    intent: dispatch.intent!,
    qa_doc: dispatch.qa_doc,
    owner: project?.vm_owner ?? "unassigned",
    project_id: dispatch.project_id,
    system_ref: project
      ? {
          ec2_instance_id: project.vm_owner,
          chrome_profile: project.chrome_profile,
          repo_path: project.repo_path,
          domain: project.domain,
        }
      : {},
    message_id: input.message_id,
    message_platform: input.message_platform,
    message_account: input.message_account,
    sender_email: input.sender_email,
    sender_name: input.sender_name,
    attachment_ids: input.attachment_ids ?? [],
  });
}
