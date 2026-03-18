export type ApprovalRequest = {
  id: string;
  subject: string;
  action: string;
  risk: string;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
};

export class ApprovalQueue {
  private requests: ApprovalRequest[] = [];

  create(req: Omit<ApprovalRequest, "status" | "createdAt">) {
    const request: ApprovalRequest = {
      ...req,
      status: "pending",
      createdAt: Date.now()
    };
    this.requests.push(request);
    return request;
  }

  approve(id: string) {
    const r = this.requests.find((x) => x.id === id);
    if (r) r.status = "approved";
    return r;
  }

  reject(id: string) {
    const r = this.requests.find((x) => x.id === id);
    if (r) r.status = "rejected";
    return r;
  }

  list() {
    return [...this.requests];
  }
}
